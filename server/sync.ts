import { one, run } from './db.js';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { and, eq, gte, lte, desc } from 'drizzle-orm';
import * as s from './schema.js';
import type { Store } from './db.js';
import type { Config } from './config.js';
import { decrypt } from './security.js';
import { Sub2ApiAdapter, type AuthType, type RemoteGet } from './adapter.js';
import { calculate, Decimal, amortize, type Rates } from '../shared/finance.js';
import { dayIn, addDay, dayStart } from './time.js';
import { refreshAccounts } from './accounts.js';
const now = () => new Date().toISOString();
const numeric = (x: any) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
export class Collector {
  private active = new Map<string, Promise<any>>();
  private lastRun = new Map<string, number>();
  constructor(
    private store: Store,
    private config: Config,
    private remote?: RemoteGet,
  ) {}
  get busy() {
    return this.active.size;
  }
  async stop() {
    await Promise.allSettled(this.active.values());
  }
  start(id: string, force = false, queueJobId?: string, attempt = 1) {
    if (this.active.has(id)) return this.active.get(id)!;
    if (!force && Date.now() - (this.lastRun.get(id) ?? 0) < 30000)
      throw Object.assign(new Error('同一站点至少间隔 30 秒同步'), { statusCode: 429 });
    this.lastRun.set(id, Date.now());
    const p = this.run(id, queueJobId, attempt).finally(() => this.active.delete(id));
    this.active.set(id, p);
    return p;
  }
  private async run(id: string, queueJobId?: string, attempt = 1) {
    const { db } = this.store,
      station = await one(db.select().from(s.stations).where(eq(s.stations.id, id)));
    if (!station) throw Object.assign(new Error('站点不存在'), { statusCode: 404 });
    const credential = await one(
      db.select().from(s.credentials).where(eq(s.credentials.stationId, id)),
    );
    if (!credential) throw new Error('缺少凭证');
    const job = randomUUID();
    await run(
      db.insert(s.syncJobs).values({
        id: job,
        stationId: id,
        status: 'running',
        startedAt: now(),
        queueJobId: queueJobId ?? null,
        attempt,
      }),
    );
    let count = 0;
    try {
      const adapter = new Sub2ApiAdapter(
        station.baseUrl,
        station.authType as AuthType,
        decrypt(credential.encrypted, this.config.ENCRYPTION_KEY),
        this.config.ALLOW_PRIVATE_HOSTS.split(',')
          .map((x) => x.trim())
          .filter(Boolean),
        this.remote,
      );
      const probe = await adapter.probe();
      if (station.kind === 'self' && probe.caps.accounts.status === 'supported')
        await refreshAccounts(this.store, id, adapter);
      await db.transaction(async (tx) => {
        for (const [name, value] of Object.entries(probe.caps))
          await run(
            tx
              .insert(s.capabilities)
              .values({ id: randomUUID(), stationId: id, name, ...value, checkedAt: now() })
              .onDuplicateKeyUpdate({ set: { ...value, checkedAt: now() } }),
          );
      });
      const supported = Object.values(probe.caps).some((v: any) => v.status === 'supported');
      const snapshot: Record<string, any> = {};
      // Persist only allowlisted operational fields. Never persist remote nested API keys, credentials or users.
      const balance = probe.payloads.balance;
      if (balance) {
        for (const k of ['balance', 'remaining', 'unit', 'mode', 'status', 'isValid'])
          if (['string', 'number', 'boolean'].includes(typeof balance[k])) snapshot[k] = balance[k];
        if (balance.quota)
          snapshot.quota = {
            limit: balance.quota.limit,
            used: balance.quota.used,
            remaining: balance.quota.remaining,
          };
      }
      if (probe.payloads.billing)
        snapshot.billing = {
          effectiveMultiplier: probe.payloads.billing.effective_rate_multiplier,
          observedAt: probe.payloads.billing.observed_at,
        };
      if (probe.payloads.realtime)
        snapshot.realtime = Object.fromEntries(
          Object.entries(probe.payloads.realtime).filter(
            ([k, v]) => typeof v === 'number' && /rpm|tpm|request|latency|success|error/i.test(k),
          ),
        );
      if (probe.payloads.accounts) {
        const items = probe.payloads.accounts.items;
        if (Array.isArray(items))
          snapshot.accounts = items.map((a: any) => ({
            id: a.id,
            name: a.name,
            status: a.status,
            schedulable: a.schedulable,
          }));
      }
      if (Array.isArray(probe.payloads.models?.data)) {
        await db.transaction(async (tx) => {
          await run(tx.delete(s.models).where(eq(s.models.stationId, id)));
          for (const m of probe.payloads.models.data)
            if (typeof m.id === 'string')
              await run(
                tx
                  .insert(s.models)
                  .values({
                    id: randomUUID(),
                    stationId: id,
                    model: m.id,
                    source: 'gateway',
                    observedAt: now(),
                  })
                  .onDuplicateKeyUpdate({ set: { id: sql`id` } }),
              );
        });
      }
      if (adapter.auth === 'api_key' && Array.isArray(balance?.daily_usage)) {
        await db.transaction(async (tx) => {
          for (const point of balance.daily_usage) {
            const day = point.date;
            if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
            const data = Object.fromEntries(
              [
                'requests',
                'input_tokens',
                'output_tokens',
                'cache_read_tokens',
                'total_tokens',
                'actual_cost',
              ]
                .filter((k) => numeric(point[k]) !== null)
                .map((k) => [k, point[k]]),
            );
            if (numeric(point.cache_write_tokens) !== null)
              data.cache_creation_tokens = point.cache_write_tokens;
            await run(
              tx
                .insert(s.aggregates)
                .values({ id: randomUUID(), stationId: id, day, data, observedAt: now() })
                .onDuplicateKeyUpdate({ set: { data, observedAt: now() } }),
            );
          }
        });
      }
      if (probe.caps.logs.status === 'supported') {
        const until = dayIn(new Date(), this.config.APP_TIMEZONE),
          since = station.checkpoint
            ? addDay(dayIn(new Date(station.checkpoint), this.config.APP_TIMEZONE), -1)
            : addDay(until, -30);
        let page = 1,
          done = false;
        while (page <= 200) {
          const r = await adapter.call(
            `${adapter.panel}/usage?page=${page}&page_size=100&start_date=${since}&end_date=${until}&timezone=${encodeURIComponent(this.config.APP_TIMEZONE)}`,
          );
          if (r.status !== 200 || !Array.isArray(r.data?.items))
            throw new Error(`使用记录同步失败（HTTP ${r.status} 或响应契约不匹配）`);
          const items = r.data.items;
          await db.transaction(async (tx) => {
            for (const row of items) {
              if (
                row.id == null ||
                typeof row.model !== 'string' ||
                !Number.isFinite(Date.parse(row.created_at))
              )
                throw new Error('使用记录缺少 ID、模型或有效时间');
              const occurredAt = new Date(row.created_at).toISOString();
              const price = await one(
                tx
                  .select()
                  .from(s.pricing)
                  .where(
                    and(
                      eq(s.pricing.stationId, id),
                      eq(s.pricing.model, row.model),
                      lte(s.pricing.effectiveAt, occurredAt),
                    ),
                  )
                  .orderBy(desc(s.pricing.effectiveAt), desc(s.pricing.createdAt)),
              );
              const tokens = {
                input: numeric(row.input_tokens),
                output: numeric(row.output_tokens),
                cacheRead: numeric(row.cache_read_tokens),
                cacheCreation: numeric(row.cache_creation_tokens),
              };
              const calc =
                price &&
                Object.values(tokens).every((x) => x !== null) &&
                (row.billing_mode ?? 'token') === 'token' &&
                !row.long_context_billing_applied &&
                !(row.cache_creation_1h_tokens > 0)
                  ? calculate(
                      tokens as any,
                      price.buy as Rates,
                      price.sell as Rates,
                      price.multiplier,
                    )
                  : null;
              const added = await run(
                tx
                  .insert(s.usage)
                  .values({
                    id: randomUUID(),
                    stationId: id,
                    externalId: String(row.id),
                    requestId: typeof row.request_id === 'string' ? row.request_id : null,
                    upstreamRequestId:
                      typeof row.upstream_request_id === 'string' ? row.upstream_request_id : null,
                    model: row.model,
                    ...tokens,
                    actualCost:
                      row.actual_cost != null && numeric(row.actual_cost) !== null
                        ? String(row.actual_cost)
                        : null,
                    currency: 'USD',
                    duration: numeric(row.duration_ms),
                    firstToken: numeric(row.first_token_ms),
                    success: null,
                    occurredAt,
                    priceId: price?.id ?? null,
                    estimatedCost: calc?.cost ?? null,
                    estimatedRevenue: calc?.revenue ?? null,
                    billingMode: row.billing_mode ?? 'token',
                  })
                  .onDuplicateKeyUpdate({ set: { id: sql`id` } }),
              );
              count += added.changes;
              await run(
                tx
                  .insert(s.models)
                  .values({
                    id: randomUUID(),
                    stationId: id,
                    model: row.model,
                    source: 'usage',
                    observedAt: now(),
                  })
                  .onDuplicateKeyUpdate({ set: { id: sql`id` } }),
              );
            }
          });
          if (items.length < 100 || (typeof r.data.pages === 'number' && page >= r.data.pages)) {
            done = true;
            break;
          }
          page++;
          await new Promise((r) => setTimeout(r, 100));
        }
        if (!done)
          throw new Error('达到单次 200 页上限；检查点未推进，请缩小首次同步窗口或分批导入');
      }
      const status = supported
        ? Object.values(probe.caps).some((v: any) =>
            ['error', 'unauthorized', 'forbidden', 'unavailable', 'rate_limited'].includes(
              v.status,
            ),
          )
          ? 'degraded'
          : 'online'
        : Object.values(probe.caps).some((v: any) => v.status === 'unauthorized')
          ? 'unauthorized'
          : 'offline';
      await run(
        db
          .update(s.stations)
          .set({
            status,
            latency: probe.latency,
            lastSync: now(),
            checkpoint:
              supported && (adapter.auth === 'api_key' || probe.caps.logs.status === 'supported')
                ? now()
                : station.checkpoint,
            snapshot,
          })
          .where(eq(s.stations.id, id)),
      );
      await run(
        db
          .update(s.syncJobs)
          .set({
            status: supported ? 'completed' : 'failed',
            finishedAt: now(),
            count,
            message: supported
              ? '采集完成；各能力状态详见站点详情'
              : '无可用接口，请检查凭证、版本和网络',
          })
          .where(eq(s.syncJobs.id, job)),
      );
      await this.correlate();
      await this.evaluate(id);
      return { jobId: job, status, count };
    } catch (error) {
      await run(
        db
          .update(s.syncJobs)
          .set({ status: 'failed', finishedAt: now(), count, message: (error as Error).message })
          .where(eq(s.syncJobs.id, job)),
      );
      await run(db.update(s.stations).set({ status: 'error' }).where(eq(s.stations.id, id)));
      await this.evaluate(id);
      return { jobId: job, status: 'error', count };
    }
  }
  async correlate() {
    const { db } = this.store;
    for (const rel of await db.select().from(s.relations)) {
      const downstream = await db
        .select()
        .from(s.usage)
        .where(eq(s.usage.stationId, rel.downstreamId));
      for (const d of downstream) {
        if (!d.upstreamRequestId) continue;
        const matches = await db
          .select()
          .from(s.usage)
          .where(
            and(eq(s.usage.stationId, rel.upstreamId), eq(s.usage.requestId, d.upstreamRequestId)),
          );
        if (matches.length === 1)
          await run(
            db
              .insert(s.correlations)
              .values({
                id: randomUUID(),
                downstreamUsageId: d.id,
                upstreamUsageId: matches[0].id,
                method: 'explicit_upstream_request_id',
                createdAt: now(),
              })
              .onDuplicateKeyUpdate({ set: { id: sql`id` } }),
          );
      }
    }
  }
  async evaluate(id: string) {
    const { db } = this.store,
      station = (await one(db.select().from(s.stations).where(eq(s.stations.id, id))))!;
    const records = await db
      .select()
      .from(s.usage)
      .where(
        and(
          eq(s.usage.stationId, id),
          gte(s.usage.occurredAt, new Date(Date.now() - 864e5).toISOString()),
        ),
      );
    for (const rule of await db.select().from(s.alertRules).where(eq(s.alertRules.enabled, true))) {
      if (rule.stationId && rule.stationId !== id) continue;
      let value: number | null = null;
      switch (rule.type) {
        case 'offline':
          value = ['offline', 'error'].includes(station.status) ? 1 : 0;
          break;
        case 'auth':
          value =
            station.status === 'unauthorized' ||
            (await one(
              db
                .select()
                .from(s.capabilities)
                .where(
                  and(eq(s.capabilities.stationId, id), eq(s.capabilities.status, 'unauthorized')),
                ),
            ))
              ? 1
              : 0;
          break;
        case 'latency':
          value = station.latency;
          break;
        case 'balance':
          value = station.snapshot?.balance ?? station.snapshot?.remaining ?? null;
          break;
        case 'sync':
          value =
            (
              await one(
                db
                  .select()
                  .from(s.syncJobs)
                  .where(eq(s.syncJobs.stationId, id))
                  .orderBy(desc(s.syncJobs.startedAt)),
              )
            )?.status === 'failed'
              ? 1
              : 0;
          break;
        case 'failure': {
          const known = records.filter((r) => r.success !== null);
          value = known.length
            ? (known.filter((r) => !r.success).length / known.length) * 100
            : null;
          break;
        }
        case 'budget': {
          const today = dayIn(new Date(), this.config.APP_TIMEZONE),
            daily = records.filter(
              (r) => dayIn(new Date(r.occurredAt), this.config.APP_TIMEZONE) === today,
            );
          if (station.costMode === 'subscription') {
            const subs = (
              await db.select().from(s.subscriptions).where(eq(s.subscriptions.stationId, id))
            ).filter((x) => x.currency === 'USD');
            value = subs.length
              ? Number(
                  subs.reduce(
                    (a, x) =>
                      a.plus(
                        amortize(
                          x.amount,
                          x.otherFees,
                          x.start,
                          x.end,
                          dayStart(today, this.config.APP_TIMEZONE),
                          now(),
                        ),
                      ),
                    new Decimal(0),
                  ),
                )
              : null;
          } else
            value = daily.some((r) => r.actualCost !== null)
              ? Number(daily.reduce((a, r) => a.plus(r.actualCost ?? 0), new Decimal(0)))
              : null;
          break;
        }
        case 'negative_margin':
          value = records.some(
            (r) =>
              r.estimatedCost !== null &&
              r.estimatedRevenue !== null &&
              new Decimal(r.estimatedCost).gt(r.estimatedRevenue),
          )
            ? 1
            : 0;
          break;
        case 'expiry': {
          const next = (
            await db.select().from(s.subscriptions).where(eq(s.subscriptions.stationId, id))
          )
            .filter((x) => Date.parse(x.end) > Date.now())
            .sort((a, b) => a.end.localeCompare(b.end))[0];
          value = next ? (Date.parse(next.end) - Date.now()) / 864e5 : null;
          break;
        }
        case 'token_spike': {
          const cutoff = Date.now() - 36e5;
          let current = 0,
            previous = 0;
          for (const r of records) {
            const total =
              (r.input ?? 0) + (r.output ?? 0) + (r.cacheRead ?? 0) + (r.cacheCreation ?? 0);
            if (Date.parse(r.occurredAt) > cutoff) current += total;
            else if (Date.parse(r.occurredAt) > cutoff - 36e5) previous += total;
          }
          value = previous ? (current / previous) * 100 : null;
          break;
        }
      }
      if (rule.type === 'balance' && value !== null && value < 0) value = null;
      const hit =
        value !== null &&
        (['balance', 'expiry'].includes(rule.type)
          ? value < Number(rule.threshold)
          : value > Number(rule.threshold));
      if (!hit) continue;
      const last = await one(
        db
          .select()
          .from(s.alerts)
          .where(and(eq(s.alerts.ruleId, rule.id), eq(s.alerts.stationId, id)))
          .orderBy(desc(s.alerts.createdAt)),
      );
      if (last && Date.now() - Date.parse(last.createdAt) < rule.cooldown * 1000) continue;
      await run(
        db.insert(s.alerts).values({
          id: randomUUID(),
          ruleId: rule.id,
          stationId: id,
          type: rule.type,
          message: `${station.name} · ${rule.type} 触发：${value}，阈值 ${rule.threshold}`,
          status: 'open',
          createdAt: now(),
        }),
      );
    }
  }
}
