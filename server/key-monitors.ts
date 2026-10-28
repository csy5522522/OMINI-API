import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Store } from './db.js';
import type { Config } from './config.js';
import type { Runtime } from './runtime.js';
import type { RemoteGet } from './adapter.js';
import { capabilityStatus, unwrap } from './adapter.js';
import { checkApiKey, type KeyProtocol } from './checks.js';
import { decrypt, encrypt, safeGet, validateTarget } from './security.js';
import { Decimal } from '../shared/finance.js';
import { alerts, audit, credentials, keyMonitors, stations } from './schema.js';

const input = z
  .object({
    name: z.string().trim().min(1).max(100),
    baseUrl: z.string().url().max(512),
    protocol: z.enum(['openai', 'anthropic', 'gemini']),
    key: z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .refine((value) => !/[\r\n]/.test(value)),
    balanceEnabled: z.boolean(),
    balanceThreshold: z.string().regex(/^\d{1,18}(\.\d{1,12})?$/),
    currency: z.enum(['USD', 'CNY', 'EUR', 'AED']),
    enabled: z.boolean(),
  })
  .strict();
const createInput = input.extend({
  protocol: input.shape.protocol.default('openai'),
  balanceEnabled: input.shape.balanceEnabled.default(false),
  balanceThreshold: input.shape.balanceThreshold.default('10'),
  currency: input.shape.currency.default('USD'),
  enabled: input.shape.enabled.default(true),
});
const allowed = (config: Config) =>
  config.ALLOW_PRIVATE_HOSTS.split(',')
    .map((x) => x.trim())
    .filter(Boolean);
export const publicMonitor = ({
  encrypted: _encrypted,
  revision: _revision,
  alertId: _alertId,
  ...row
}: typeof keyMonitors.$inferSelect) => row;
const maskedKey = (key: string) => (key.length > 8 ? `••••${key.slice(-4)}` : '••••••••');

export async function inspectKeyMonitor(
  monitor: Pick<
    typeof keyMonitors.$inferSelect,
    'baseUrl' | 'protocol' | 'balanceEnabled' | 'currency'
  >,
  key: string,
  allow: string[],
  get: RemoteGet = safeGet,
) {
  const result = await checkApiKey(
    monitor.baseUrl,
    key,
    monitor.protocol as KeyProtocol,
    allow,
    get,
  );
  // An upstream must never be able to echo the secret into stored model names.
  result.models = result.models.map((name: string) => name.split(key).join('[REDACTED]'));
  const balance: { status: string; amount: string | null; currency: string | null } = {
    status: 'disabled',
    amount: null,
    currency: null,
  };
  if (monitor.balanceEnabled) {
    balance.status = 'unsupported';
    if (['unauthorized', 'forbidden', 'rate_limited', 'error'].includes(result.status))
      balance.status = result.status;
    if (
      monitor.protocol === 'openai' &&
      !['unauthorized', 'forbidden', 'rate_limited', 'error'].includes(result.status)
    ) {
      try {
        const response = await get(
          monitor.baseUrl.replace(/\/$/, '').replace(/\/v1$/, ''),
          '/v1/usage?days=30',
          { authorization: `Bearer ${key}` },
          allow,
        );
        balance.status = capabilityStatus(response.status);
        if (balance.status === 'supported') {
          const data = unwrap(response.data);
          const amount = data?.balance ?? data?.remaining;
          // A remaining-token count must not be presented as account money.
          const currency = data?.unit ?? data?.currency;
          if (
            ['string', 'number'].includes(typeof amount) &&
            /^-?\d{1,18}(\.\d{1,12})?$/.test(String(amount)) &&
            ['USD', 'CNY', 'EUR', 'AED'].includes(currency)
          ) {
            balance.amount = new Decimal(amount).toString();
            balance.currency = currency;
          } else balance.status = 'unavailable';
        }
      } catch {
        balance.status = 'error';
      }
    }
  }
  return { ...result, balance, checkedAt: new Date().toISOString() };
}

export async function collectKeyMonitor(store: Store, config: Config, id: string, get?: RemoteGet) {
  const [monitor] = await store.db.select().from(keyMonitors).where(eq(keyMonitors.id, id));
  if (!monitor?.enabled) return { skipped: true };
  const result = await inspectKeyMonitor(
    monitor,
    decrypt(monitor.encrypted, config.ENCRYPTION_KEY),
    allowed(config),
    get,
  );
  const issue =
    result.status !== 'supported'
      ? result.status
      : result.balance.status === 'supported' &&
          result.balance.currency === monitor.currency &&
          result.balance.amount !== null &&
          new Decimal(result.balance.amount).lt(monitor.balanceThreshold)
        ? 'low_balance'
        : null;
  await store.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(keyMonitors)
      .where(eq(keyMonitors.id, id))
      .for('update');
    // Discard in-flight results if a key was changed, paused or deleted.
    if (!current?.enabled || current.revision !== monitor.revision) return;
    let alertId = current.alertId,
      lastAlertAt = current.lastAlertAt;
    if (current.incident !== issue && alertId) {
      await tx.update(alerts).set({ status: 'resolved' }).where(eq(alerts.id, alertId));
      alertId = null;
    }
    if (
      issue &&
      (current.incident !== issue ||
        !lastAlertAt ||
        Date.now() - Date.parse(lastAlertAt) >= 3600000)
    ) {
      if (alertId)
        await tx.update(alerts).set({ status: 'resolved' }).where(eq(alerts.id, alertId));
      alertId = randomUUID();
      lastAlertAt = result.checkedAt;
      await tx.insert(alerts).values({
        id: alertId,
        type: 'key',
        status: 'open',
        createdAt: lastAlertAt,
        message:
          issue === 'low_balance'
            ? `API Key「${current.name}」余额 ${result.balance.amount} ${result.balance.currency}，低于阈值 ${current.balanceThreshold} ${current.currency}`
            : `API Key「${current.name}」：${result.message}`,
      });
    }
    await tx
      .update(keyMonitors)
      .set({ result, checkedAt: result.checkedAt, incident: issue, alertId, lastAlertAt })
      .where(eq(keyMonitors.id, id));
  });
  return { ok: true };
}

export function registerKeyMonitors(
  app: FastifyInstance,
  store: Store,
  config: Config,
  runtime: Runtime,
) {
  const find = async (id: string) => {
    const [row] = await store.db.select().from(keyMonitors).where(eq(keyMonitors.id, id));
    if (!row) throw Object.assign(new Error('API Key 监控不存在'), { statusCode: 404 });
    return row;
  };
  const idFrom = (req: any) => z.string().uuid().parse(req.params.id);
  const target = async (baseUrl: string) => {
    try {
      await validateTarget(baseUrl, allowed(config));
    } catch {
      throw Object.assign(new Error('API 地址无法解析或未通过安全检查'), { statusCode: 400 });
    }
  };
  const record = (action: string, id: string) => ({
    id: randomUUID(),
    action,
    entityId: id,
    details: {},
    createdAt: new Date().toISOString(),
  });
  const add = async (body: z.infer<typeof input>) => {
    await target(body.baseUrl);
    const id = randomUUID(),
      { key, ...values } = body;
    await store.db.transaction(async (tx) => {
      await tx
        .insert(keyMonitors)
        .values({
          ...values,
          id,
          encrypted: encrypt(key, config.ENCRYPTION_KEY),
          masked: maskedKey(key),
          createdAt: new Date().toISOString(),
        });
      await tx.insert(audit).values(record('key-monitor.create', id));
    });
    // Configuration survives a temporarily unavailable queue; the next scan retries.
    if (body.enabled) await runtime.enqueueMonitor(id, false).catch(() => {});
    return publicMonitor(await find(id));
  };
  app.get('/api/key-monitors', async () => ({
    monitors: (await store.db.select().from(keyMonitors).orderBy(desc(keyMonitors.createdAt))).map(
      publicMonitor,
    ),
    intervalSeconds: config.SYNC_INTERVAL_SECONDS,
  }));
  app.post('/api/key-monitors', async (req, reply) =>
    reply.code(201).send(await add(createInput.parse(req.body))),
  );
  app.post('/api/key-monitors/import', async (req, reply) => {
    const { stationId } = z
      .object({ stationId: z.string().min(1).max(64) })
      .strict()
      .parse(req.body);
    const [station] = await store.db.select().from(stations).where(eq(stations.id, stationId));
    const [credential] = await store.db
      .select()
      .from(credentials)
      .where(eq(credentials.stationId, stationId));
    if (station?.authType !== 'api_key' || !credential)
      throw Object.assign(new Error('仅可导入已保存模型 API Key 的站点'), { statusCode: 400 });
    return reply
      .code(201)
      .send(
        await add(
          createInput.parse({
            name: station.name,
            baseUrl: station.baseUrl,
            key: decrypt(credential.encrypted, config.ENCRYPTION_KEY),
            balanceEnabled: true,
            currency: station.currency,
          }),
        ),
      );
  });
  app.patch('/api/key-monitors/:id', async (req) => {
    const id = idFrom(req),
      current = await find(id);
    const changes = input.partial().parse(req.body);
    if (changes.baseUrl) await target(changes.baseUrl);
    const { key, ...values } = changes;
    await store.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(keyMonitors)
        .where(eq(keyMonitors.id, id))
        .for('update');
      if (!locked) throw Object.assign(new Error('API Key 监控不存在'), { statusCode: 404 });
      if (locked.alertId)
        await tx.update(alerts).set({ status: 'resolved' }).where(eq(alerts.id, locked.alertId));
      await tx
        .update(keyMonitors)
        .set({
          ...values,
          ...(key
            ? { encrypted: encrypt(key, config.ENCRYPTION_KEY), masked: maskedKey(key) }
            : {}),
          revision: sql`${keyMonitors.revision} + 1`,
          result: null,
          checkedAt: null,
          incident: null,
          alertId: null,
          lastAlertAt: null,
        })
        .where(eq(keyMonitors.id, id));
      await tx.insert(audit).values(record('key-monitor.update', id));
    });
    if (changes.enabled ?? current.enabled) await runtime.enqueueMonitor(id, false).catch(() => {});
    return publicMonitor(await find(id));
  });
  app.delete('/api/key-monitors/:id', async (req) => {
    const id = idFrom(req);
    await store.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(keyMonitors)
        .where(eq(keyMonitors.id, id))
        .for('update');
      if (!current) throw Object.assign(new Error('API Key 监控不存在'), { statusCode: 404 });
      if (current.alertId)
        await tx.update(alerts).set({ status: 'resolved' }).where(eq(alerts.id, current.alertId));
      await tx.delete(keyMonitors).where(eq(keyMonitors.id, id));
      await tx.insert(audit).values(record('key-monitor.delete', id));
    });
    return { ok: true };
  });
  app.post(
    '/api/key-monitors/:id/refresh',
    { config: { rateLimit: { max: 10, timeWindow: 60000 } } },
    async (req) => {
      const id = idFrom(req),
        current = await find(id);
      if (!current.enabled) throw Object.assign(new Error('请先启用此监控'), { statusCode: 409 });
      await runtime.refreshMonitor(id);
      return publicMonitor(await find(id));
    },
  );
}
