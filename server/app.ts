import { one, run } from './db.js';
import { sql } from 'drizzle-orm';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { and, eq, desc, gte, lt, like, or } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import type { Config } from './config.js';
import type { Store } from './db.js';
import * as s from './schema.js';
import { encrypt, passwordMatches, validateTarget } from './security.js';
import { openRuntime, type Runtime } from './runtime.js';
import { report } from './reports.js';
import * as v from './validation.js';
import { calculate, Decimal, type Rates } from '../shared/finance.js';
import { Sub2ApiAdapter, type AuthType, type RemoteGet } from './adapter.js';
import { decrypt } from './security.js';
import { dayIn, dayStart, addDay } from './time.js';
import { syncExchange } from './exchange.js';
import { refreshAccounts } from './accounts.js';
import { checkApiKey, testAccount } from './checks.js';
import { safePost, type RemotePost } from './security.js';
import { registerMcp } from './mcp.js';
import { accountAccess } from './account-access.js';
const now = () => new Date().toISOString();
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export async function createApp(
  config: Config,
  store: Store,
  options: {
    remote?: RemoteGet;
    remotePost?: RemotePost;
    logger?: boolean;
    runtime?: Runtime;
  } = {},
) {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 32768,
    logController: new Fastify.LogController({ disableRequestLogging: true }),
  });
  const { db } = store;
  const runtime = options.runtime ?? (await openRuntime(config, store, options.remote));
  const collector = runtime.collector;
  if (config.PROCESS_ROLE === 'all') await runtime.startWorkers();
  await app.register(cookie, { secret: config.SESSION_SECRET });
  await app.register(rateLimit, {
    max: 180,
    timeWindow: 60000,
    redis: runtime.redis,
    nameSpace: config.REDIS_PREFIX + ':rate:',
  });
  app.addHook('onResponse', async (req, reply) => {
    if (
      req.url.startsWith('/api/') &&
      !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
      reply.statusCode < 400
    )
      await runtime.invalidate().catch(() => {});
  });
  app.addHook('onRequest', async (req, reply) => {
    reply
      .header('X-Content-Type-Options', 'nosniff')
      .header('X-Frame-Options', 'DENY')
      .header('Referrer-Policy', 'no-referrer')
      .header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'",
      );
    if (!req.url.startsWith('/api/')) return;
    reply.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.headers['x-requested-with'] !== 'observatory')
        return reply.code(403).send({ message: '缺少同源请求标识' });
      if (req.headers.origin) {
        let origin;
        try {
          origin = new URL(req.headers.origin);
        } catch {
          return reply.code(403).send({ message: '无效来源' });
        }
        if (origin.host !== req.headers.host)
          return reply.code(403).send({ message: '禁止跨站写入' });
      }
    }
    if (req.url === '/api/login' || req.url === '/api/health') return;
    const signed = req.cookies.session,
      token = signed ? req.unsignCookie(signed) : null;
    if (!token?.valid || !token.value) return reply.code(401).send({ message: '请先登录' });
    const session = await one(
      db
        .select()
        .from(s.sessions)
        .where(eq(s.sessions.id, hash(token.value))),
    );
    if (!session || session.expiresAt < Date.now())
      return reply.code(401).send({ message: '会话已过期，请重新登录' });
  });
  app.setErrorHandler((error, req, reply) => {
    if (req.url === '/mcp') {
      const parseError = (error as any).code === 'FST_ERR_CTP_INVALID_JSON_BODY';
      const status = (error as any).statusCode ?? 500;
      return reply.code(status).send({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: parseError ? -32700 : -32603,
          message: parseError ? 'Parse error' : 'Request failed',
        },
      });
    }
    if (error instanceof ZodError)
      return reply
        .code(400)
        .send({ message: error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('；') });
    const err = error as Error & {
      statusCode?: number;
      code?: string;
    };
    const dbCode = (error as any).cause?.code ?? err.code;
    if (
      dbCode === 'ER_DUP_ENTRY' &&
      String((error as any).cause?.sqlMessage ?? err.message).includes('station_single_main')
    )
      return reply
        .code(409)
        .send({ message: '只能配置一个主中转站，请编辑现有主中转站；上游账号从主站自动获取' });
    if (
      [
        'ER_DUP_ENTRY',
        'ER_NO_REFERENCED_ROW_2',
        'ER_ROW_IS_REFERENCED_2',
        'ER_CHECK_CONSTRAINT_VIOLATED',
      ].includes(dbCode)
    )
      return reply.code(409).send({ message: '数据关联冲突，请检查站点、价格版本和请求关联' });
    const code = err.statusCode ?? 500;
    if (code >= 500) app.log.error({ type: err.name }, '操作失败');
    return reply
      .code(code)
      .send({ message: code >= 500 ? '操作失败，请查看同步状态或服务日志' : err.message });
  });
  const audit = async (
    action: string,
    id: string,
    details: unknown = {},
    executor: Pick<Store['db'], 'insert'> = db,
  ) =>
    await run(
      executor
        .insert(s.audit)
        .values({ id: randomUUID(), action, entityId: id, details, createdAt: now() }),
    );
  const station = async (id: string) => {
    const found = await one(db.select().from(s.stations).where(eq(s.stations.id, id)));
    if (!found) throw Object.assign(new Error('站点不存在'), { statusCode: 404 });
    return found;
  };
  const parseId = (req: any) => z.string().uuid().parse(req.params.id);
  const range = (query: any) => {
    const today = dayIn(new Date(), config.APP_TIMEZONE);
    const q = z
      .object({
        from: v.date.optional(),
        to: v.date.optional(),
        stationId: z.string().optional(),
        model: z.string().optional(),
      })
      .parse(query);
    const from = q.from ?? dayStart(today, config.APP_TIMEZONE),
      to = q.to ?? dayStart(addDay(today, 1), config.APP_TIMEZONE);
    if (from >= to || Date.parse(to) - Date.parse(from) > 366 * 864e5)
      throw Object.assign(new Error('时间范围须为正且不超过 366 天'), { statusCode: 400 });
    return { ...q, from, to };
  };
  app.get('/api/health', async (_req, reply) => {
    try {
      return { ok: true, ...(await runtime.health()) };
    } catch {
      return reply.code(503).send({ ok: false, message: 'MySQL 或 Redis 暂不可用' });
    }
  });
  app.post(
    '/api/login',
    { config: { rateLimit: { max: 8, timeWindow: 60000 } } },
    async (req, reply) => {
      const body = z
        .object({ username: z.string().max(100), password: z.string().max(1000) })
        .parse(req.body);
      if (
        !passwordMatches(body.password, config.ADMIN_PASSWORD) ||
        body.username !== config.ADMIN_USERNAME
      )
        return reply.code(401).send({ message: '用户名或密码错误' });
      const token = randomBytes(32).toString('hex');
      await run(db.delete(s.sessions).where(lt(s.sessions.expiresAt, Date.now())));
      await run(
        db.insert(s.sessions).values({ id: hash(token), expiresAt: Date.now() + 12 * 36e5 }),
      );
      reply.setCookie('session', token, {
        httpOnly: true,
        sameSite: 'strict',
        secure: config.COOKIE_SECURE === 'true',
        path: '/',
        signed: true,
        maxAge: 43200,
      });
      return { username: config.ADMIN_USERNAME };
    },
  );
  app.get('/api/me', async () => ({ username: config.ADMIN_USERNAME }));
  registerMcp(app, store, config);
  const mainAdapter = async () => {
    const st = await one(db.select().from(s.stations).where(eq(s.stations.kind, 'self')));
    if (!st) throw Object.assign(new Error('请先配置主中转站'), { statusCode: 409 });
    const cred = await one(
      db.select().from(s.credentials).where(eq(s.credentials.stationId, st.id)),
    );
    if (!cred) throw Object.assign(new Error('主站缺少管理员凭证'), { statusCode: 409 });
    const secret = decrypt(cred.encrypted, config.ENCRYPTION_KEY);
    const allow = config.ALLOW_PRIVATE_HOSTS.split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    const headers: Record<string, string> =
      st.authType === 'admin_key' ? { 'x-api-key': secret } : { authorization: `Bearer ${secret}` };
    return {
      st,
      allow,
      headers,
      adapter: new Sub2ApiAdapter(
        st.baseUrl,
        st.authType as AuthType,
        secret,
        allow,
        options.remote,
      ),
    };
  };
  app.get('/api/accounts', async () =>
    db.select().from(s.upstreamAccounts).orderBy(s.upstreamAccounts.name),
  );
  app.get('/api/accounts/:id/key', async (req) => {
    const id = parseId(req);
    const account = await one(
      db.select().from(s.upstreamAccounts).where(eq(s.upstreamAccounts.id, id)),
    );
    if (!account) throw Object.assign(new Error('账号不存在，请重新获取列表'), { statusCode: 404 });
    const { st, adapter } = await mainAdapter();
    if (account.stationId !== st.id)
      throw Object.assign(new Error('账号不属于当前主站'), { statusCode: 409 });
    const result = await accountAccess(adapter, account);
    await audit('account.key.read', id, { status: result.status });
    return result;
  });
  app.post(
    '/api/accounts/refresh',
    { config: { rateLimit: { max: 3, timeWindow: 60000 } } },
    async () => {
      const { st, adapter } = await mainAdapter();
      const count = await refreshAccounts(store, st.id, adapter);
      await audit('account.refresh', st.id, { count });
      return { count, message: `已从 Sub2API 获取 ${count} 个账号` };
    },
  );
  app.post(
    '/api/accounts/:id/check',
    { config: { rateLimit: { max: 120, timeWindow: 60000 } } },
    async (req) => {
      const body = z
        .object({
          model: z.string().trim().min(1).max(200).optional(),
          mode: z.enum(['readonly', 'generation']).default('readonly'),
          acknowledgeUsage: z.boolean().optional(),
        })
        .strict()
        .parse(req.body);
      const id = parseId(req),
        account = await one(
          db.select().from(s.upstreamAccounts).where(eq(s.upstreamAccounts.id, id)),
        );
      if (!account)
        throw Object.assign(new Error('账号不存在，请重新获取列表'), { statusCode: 404 });
      if (body.mode === 'generation' && !body.acknowledgeUsage)
        throw Object.assign(new Error('生成测试会产生上游用量，请先确认用量提示'), {
          statusCode: 400,
        });
      const { st, allow, headers, adapter } = await mainAdapter();
      if (account.stationId !== st.id)
        throw Object.assign(new Error('账号不属于当前主站'), { statusCode: 409 });
      const lockKey = `${config.REDIS_PREFIX}:account-check:${id}`;
      const lockToken = randomUUID();
      if (!(await runtime.redis.set(lockKey, lockToken, 'PX', 60000, 'NX')))
        throw Object.assign(new Error('该账号正在检测，请稍后查看结果'), { statusCode: 429 });
      let result;
      try {
        if (body.mode === 'readonly') {
          const access = await accountAccess(adapter, account);
          if (!access.apiKey || !access.baseUrl) {
            result = {
              status: access.status === 'supported' ? 'unavailable' : access.status,
              httpStatus: null,
              latency: 0,
              checkedAt: now(),
              message: !access.baseUrl
                ? '主站未提供 API 地址，请选择生成测试或检查账号配置'
                : access.message,
            };
          } else {
            result = await checkApiKey(
              access.baseUrl,
              access.apiKey,
              access.protocol,
              allow,
              options.remote,
            );
          }
        } else
          result = await testAccount(
            st.baseUrl,
            account.externalId,
            headers,
            allow,
            options.remotePost ?? safePost,
            body.model,
          );
      } finally {
        await runtime.redis.eval(
          "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
          1,
          lockKey,
          lockToken,
        );
      }
      await run(
        db
          .update(s.upstreamAccounts)
          .set({ checkedAt: result.checkedAt, checkResult: result })
          .where(eq(s.upstreamAccounts.id, id)),
      );
      await audit('account.check', id, { status: result.status });
      return result;
    },
  );
  app.post(
    '/api/keys/check',
    { config: { rateLimit: { max: 10, timeWindow: 60000 } } },
    async (req) => {
      const body = z
        .object({
          baseUrl: z.string().url().max(512),
          key: z
            .string()
            .trim()
            .min(1)
            .max(8192)
            .refine((k) => !/[\r\n]/.test(k)),
          protocol: z.enum(['openai', 'anthropic', 'gemini']).default('openai'),
        })
        .strict()
        .parse(req.body);
      const allow = config.ALLOW_PRIVATE_HOSTS.split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      try {
        await validateTarget(body.baseUrl, allow);
      } catch {
        throw Object.assign(
          new Error('API 地址无法解析或未通过安全检查；内网站点需先配置允许的主机'),
          { statusCode: 400 },
        );
      }
      const result = await checkApiKey(
        body.baseUrl,
        body.key,
        body.protocol,
        allow,
        options.remote,
      );
      await audit('key.check', 'manual', { protocol: body.protocol, status: result.status });
      return result;
    },
  );
  app.post('/api/logout', async (req, reply) => {
    const token = req.unsignCookie(req.cookies.session ?? '');
    if (token.value) await run(db.delete(s.sessions).where(eq(s.sessions.id, hash(token.value))));
    reply.clearCookie('session', { path: '/' });
    return { ok: true };
  });
  app.get('/api/state', async (req, reply) => {
    const q = range(req.query);
    const cached = await runtime.cached('state:' + JSON.stringify(q), async () => {
      const [
        stationRows,
        credentialRows,
        capabilityRows,
        modelRows,
        prices,
        relations,
        correlations,
        rules,
        alerts,
        jobs,
        recharges,
        transactions,
        exchangeRates,
        auditRows,
        settings,
        reportData,
        queueStats,
      ] = await Promise.all([
        db.select().from(s.stations),
        db
          .select({ stationId: s.credentials.stationId, masked: s.credentials.masked })
          .from(s.credentials),
        db.select().from(s.capabilities),
        db.select().from(s.models),
        db.select().from(s.pricing).orderBy(desc(s.pricing.effectiveAt)),
        db.select().from(s.relations),
        db.select().from(s.correlations),
        db.select().from(s.alertRules),
        db.select().from(s.alerts).orderBy(desc(s.alerts.createdAt)).limit(200),
        db.select().from(s.syncJobs).orderBy(desc(s.syncJobs.startedAt)).limit(100),
        db.select().from(s.recharges).orderBy(desc(s.recharges.occurredAt)),
        db.select().from(s.transactions).orderBy(desc(s.transactions.occurredAt)),
        db.select().from(s.fxRates).orderBy(desc(s.fxRates.effectiveAt)),
        db.select().from(s.audit).orderBy(desc(s.audit.createdAt)).limit(100),
        db.select().from(s.settings),
        report(store, q.from, q.to, config.APP_TIMEZONE, q.stationId, q.model),
        runtime.stats(),
      ]);
      return {
        stations: stationRows.map((st) => ({
          ...st,
          credential: credentialRows.find((x) => x.stationId === st.id)?.masked ?? '未配置',
          capabilities: capabilityRows.filter((c) => c.stationId === st.id),
        })),
        models: modelRows,
        prices,
        relations,
        correlations,
        rules,
        alerts,
        jobs,
        recharges,
        transactions,
        exchangeRates,
        audit: auditRows,
        settings: settings.filter((x) => x.key !== 'environment'),
        fxProvider: config.FX_PROVIDER,
        report: reportData,
        timezone: config.APP_TIMEZONE,
        syncIntervalSeconds: config.SYNC_INTERVAL_SECONDS,
        range: q,
        queueStats,
        storage: {
          database: 'MySQL',
          queue: 'BullMQ / Redis',
          cache: 'Redis',
          cacheTtlSeconds: config.CACHE_TTL_SECONDS,
        },
      };
    });
    reply.header('X-Data-Cache', cached.hit ? 'HIT' : 'MISS');
    return cached.data;
  });
  app.post('/api/stations', async (req, reply) => {
    const body = v.stationBody.parse(req.body);
    if (
      body.kind === 'self' &&
      (await one(
        db
          .select({ id: s.stations.id })
          .from(s.stations)
          .where(eq(s.stations.kind, 'self'))
          .limit(1),
      ))
    )
      return reply
        .code(409)
        .send({ message: '只能配置一个主中转站，请编辑现有主中转站；上游账号从主站自动获取' });
    await validateTarget(
      body.baseUrl,
      config.ALLOW_PRIVATE_HOSTS.split(',').map((x) => x.trim()),
    );
    const { credential, balanceThreshold, ...fields } = body,
      id = randomUUID();
    await db.transaction(async (tx) => {
      await run(tx.insert(s.stations).values({ id, ...fields, createdAt: now() }));
      await run(
        tx.insert(s.credentials).values({
          stationId: id,
          encrypted: encrypt(credential, config.ENCRYPTION_KEY),
          masked: '••••••••',
        }),
      );
      if (balanceThreshold !== undefined)
        for (const [type, threshold] of [
          ['balance', balanceThreshold],
          ['auth', '0'],
          ['sync', '0'],
        ])
          await run(
            tx.insert(s.alertRules).values({
              id: randomUUID(),
              stationId: id,
              type,
              threshold,
              cooldown: 3600,
              enabled: true,
            }),
          );
    });
    await audit('station.create', id, { authType: body.authType });
    if (balanceThreshold !== undefined) {
      try {
        await runtime.enqueue(id);
      } catch {
        return reply
          .code(201)
          .send({ id, message: '监控已保存，首次采集未入队，请点击立即刷新重试' });
      }
      return reply.code(201).send({ id, message: '余额监控已启用' });
    }
    return reply.code(201).send({ id });
  });
  app.patch('/api/stations/:id', async (req) => {
    const id = parseId(req);
    await station(id);
    const body = z
      .object({
        name: z.string().min(1).max(80).optional(),
        notes: z.string().max(2000).optional(),
        costMode: z.enum(['token', 'prepaid', 'subscription']).optional(),
        credential: z.string().min(1).max(8192).optional(),
      })
      .strict()
      .parse(req.body);
    await db.transaction(async (tx) => {
      const { credential, ...fields } = body;
      if (Object.keys(fields).length)
        await run(tx.update(s.stations).set(fields).where(eq(s.stations.id, id)));
      if (credential)
        await run(
          tx
            .update(s.credentials)
            .set({ encrypted: encrypt(credential, config.ENCRYPTION_KEY) })
            .where(eq(s.credentials.stationId, id)),
        );
      await audit('station.update', id, { ...fields, credentialUpdated: !!credential }, tx);
    });
    return { ok: true };
  });
  app.delete('/api/stations/:id', async (req) => {
    const id = parseId(req);
    await station(id);
    await run(db.delete(s.stations).where(eq(s.stations.id, id)));
    await audit('station.delete', id);
    return { ok: true };
  });
  app.post('/api/stations/:id/sync', async (req, reply) => {
    const id = parseId(req);
    await station(id);
    const body = z
      .object({ wait: z.boolean().default(false) })
      .default({ wait: false })
      .parse(req.body);
    if (body.wait) {
      await runtime.refresh(id);
      await runtime.invalidate();
      const updated = await station(id);
      return { ok: true, status: updated.status, lastSync: updated.lastSync };
    }
    const result = await runtime.enqueue(id);
    return reply.code(202).send({
      message: '正在刷新',
      ...result,
    });
  });
  app.post('/api/prices', async (req, reply) => {
    const body = v.priceBody.parse(req.body);
    await station(body.stationId);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await run(tx.insert(s.pricing).values({ id, ...body, source: 'manual', createdAt: now() }));
      await audit('price.create', id, body, tx);
    });
    return reply.code(201).send({ id });
  });
  app.post('/api/stations/:id/import-price', async (req) => {
    const id = parseId(req),
      st = await station(id),
      body = z.object({ model: z.string().min(1).max(200) }).parse(req.body);
    if (!['admin_key', 'admin_jwt'].includes(st.authType))
      throw Object.assign(new Error('此接口需要管理员权限'), { statusCode: 403 });
    const cred = (await one(
      db.select().from(s.credentials).where(eq(s.credentials.stationId, id)),
    ))!;
    const adapter = new Sub2ApiAdapter(
      st.baseUrl,
      st.authType as AuthType,
      decrypt(cred.encrypted, config.ENCRYPTION_KEY),
      config.ALLOW_PRIVATE_HOSTS.split(','),
      options.remote,
    );
    const r = await adapter.call(
      `/api/v1/admin/channels/model-pricing?model=${encodeURIComponent(body.model)}`,
    );
    if (r.status !== 200 || r.data?.found !== true)
      throw Object.assign(new Error(`未获取到模型默认价（HTTP ${r.status}）`), { statusCode: 422 });
    // Reference catalog prices are not actual buy/sell prices; return a preview for manual confirmation.
    const fields = {
      input: 'input_price',
      output: 'output_price',
      cacheRead: 'cache_read_price',
      cacheCreation: 'cache_write_price',
    };
    const rates = Object.fromEntries(
      Object.entries(fields).map(([key, field]) => [
        key,
        r.data[field] == null ? null : new Decimal(String(r.data[field])).times(1e6).toString(),
      ]),
    );
    return {
      rates,
      currency: 'USD',
      source: 'Sub2API 默认价格目录；需确认实际采购与销售倍率后保存',
      cacheWrite1h: r.data.cache_write_1h_price ?? null,
    };
  });
  app.post('/api/calculator', async (req) => {
    const body = z
      .object({
        tokens: z.object({
          input: z.number().int().nonnegative().max(1e12),
          output: z.number().int().nonnegative().max(1e12),
          cacheRead: z.number().int().nonnegative().max(1e12),
          cacheCreation: z.number().int().nonnegative().max(1e12),
        }),
        buy: v.rates,
        sell: v.rates,
        multiplier: v.money,
        fx: v.money.refine((x) => Number(x) > 0),
        other: v.money.default('0'),
      })
      .parse(req.body);
    return {
      ...calculate(body.tokens, body.buy, body.sell, body.multiplier, body.fx, body.other),
      classification: 'estimate',
    };
  });
  app.post('/api/subscriptions', async (req, reply) => {
    const body = v.subscriptionBody.parse(req.body);
    await station(body.stationId);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await run(tx.insert(s.subscriptions).values({ id, ...body, createdAt: now() }));
      await audit('subscription.create', id, body, tx);
    });
    return reply.code(201).send({ id });
  });
  app.post('/api/recharges', async (req, reply) => {
    const body = v.transactionBody.omit({ kind: true }).parse(req.body);
    await station(body.stationId);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await run(tx.insert(s.recharges).values({ id, ...body }));
      await audit('recharge.create', id, body, tx);
    });
    return reply.code(201).send({ id });
  });
  app.post('/api/transactions', async (req, reply) => {
    const body = v.transactionBody.parse(req.body);
    await station(body.stationId);
    const id = randomUUID();
    const fx = await one(
      db
        .select()
        .from(s.fxRates)
        .where(
          and(
            eq(s.fxRates.from, body.currency),
            eq(s.fxRates.to, 'USD'),
            lt(s.fxRates.effectiveAt, body.occurredAt),
          ),
        )
        .orderBy(desc(s.fxRates.effectiveAt)),
    );
    await db.transaction(async (tx) => {
      await run(tx.insert(s.transactions).values({ id, ...body, fxId: fx?.id ?? null }));
      await audit('transaction.create', id, body, tx);
    });
    return reply.code(201).send({ id });
  });
  app.post('/api/exchange-rates', async (req, reply) => {
    const body = z
      .object({
        from: v.currency,
        to: v.currency,
        rate: v.money.refine((x) => Number(x) > 0),
        effectiveAt: v.date,
        source: z.string().min(1).max(200),
      })
      .refine((x) => x.from !== x.to)
      .parse(req.body);
    const id = randomUUID();
    await db.transaction(async (tx) => {
      await run(tx.insert(s.fxRates).values({ id, ...body }));
      await audit('exchange-rate.create', id, body, tx);
    });
    return reply.code(201).send({ id });
  });
  app.post(
    '/api/exchange-rates/sync',
    { config: { rateLimit: { max: 2, timeWindow: 3600000 } } },
    async () => syncExchange(store, config.FX_PROVIDER ?? 'none'),
  );
  app.post('/api/relations', async (req, reply) => {
    const body = z
      .object({ downstreamId: z.string().uuid(), upstreamId: z.string().uuid() })
      .parse(req.body);
    const downstream = await station(body.downstreamId),
      upstream = await station(body.upstreamId);
    if (downstream.kind !== 'self' || upstream.kind !== 'third_party')
      throw Object.assign(new Error('只允许将主中转站关联到第三方上游中转站'), { statusCode: 400 });
    const edges = await db.select().from(s.relations);
    const visit = (id: string, seen = new Set<string>()): boolean => {
      if (id === body.downstreamId) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return edges.filter((x) => x.downstreamId === id).some((x) => visit(x.upstreamId, seen));
    };
    if (visit(body.upstreamId))
      throw Object.assign(new Error('站点关系不能形成循环'), { statusCode: 400 });
    const id = randomUUID();
    await run(db.insert(s.relations).values({ id, ...body }));
    await audit('relation.create', id, body);
    await collector.correlate();
    return reply.code(201).send({ id });
  });
  app.delete('/api/relations/:id', async (req) => {
    const id = parseId(req),
      rel = await one(db.select().from(s.relations).where(eq(s.relations.id, id)));
    if (!rel) throw Object.assign(new Error('关系不存在'), { statusCode: 404 });
    await db.transaction(async (tx) => {
      for (const link of await tx.select().from(s.correlations)) {
        const down = await one(
            tx.select().from(s.usage).where(eq(s.usage.id, link.downstreamUsageId)),
          ),
          up = await one(tx.select().from(s.usage).where(eq(s.usage.id, link.upstreamUsageId)));
        if (down?.stationId === rel.downstreamId && up?.stationId === rel.upstreamId)
          await run(tx.delete(s.correlations).where(eq(s.correlations.id, link.id)));
      }
      await run(tx.delete(s.relations).where(eq(s.relations.id, id)));
      await audit('relation.delete', id, rel, tx);
    });
    return { ok: true };
  });
  app.post('/api/correlations', async (req, reply) => {
    const body = z
      .object({
        downstreamUsageId: z.string(),
        upstreamUsageId: z.string(),
        evidence: z.string().min(10).max(500),
      })
      .parse(req.body);
    const down = await one(db.select().from(s.usage).where(eq(s.usage.id, body.downstreamUsageId))),
      up = await one(db.select().from(s.usage).where(eq(s.usage.id, body.upstreamUsageId)));
    if (
      !down ||
      !up ||
      !(await one(
        db
          .select()
          .from(s.relations)
          .where(
            and(
              eq(s.relations.downstreamId, down.stationId),
              eq(s.relations.upstreamId, up.stationId),
            ),
          ),
      ))
    )
      throw Object.assign(new Error('记录不存在或站点尚未配置上下游关系'), { statusCode: 400 });
    const id = randomUUID();
    await run(
      db.insert(s.correlations).values({
        id,
        downstreamUsageId: down.id,
        upstreamUsageId: up.id,
        method: 'manual',
        createdAt: now(),
      }),
    );
    await audit('correlation.create', id, body);
    return reply.code(201).send({ id });
  });
  app.post('/api/alert-rules', async (req, reply) => {
    const body = z
      .object({
        stationId: z.string().uuid().nullable().default(null),
        type: z.enum([
          'offline',
          'auth',
          'failure',
          'latency',
          'balance',
          'token_spike',
          'budget',
          'negative_margin',
          'expiry',
          'sync',
        ]),
        threshold: v.money,
        cooldown: z.number().int().min(60).max(86400),
        enabled: z.boolean().default(true),
      })
      .parse(req.body);
    if (body.stationId) await station(body.stationId);
    const id = randomUUID();
    await run(db.insert(s.alertRules).values({ id, ...body }));
    await audit('alert-rule.create', id, body);
    return reply.code(201).send({ id });
  });
  app.patch('/api/alert-rules/:id', async (req) => {
    const id = parseId(req),
      body = z
        .object({
          enabled: z.boolean().optional(),
          threshold: v.money.optional(),
          cooldown: z.number().int().min(60).max(86400).optional(),
        })
        .strict()
        .refine((x) => Object.keys(x).length > 0)
        .parse(req.body);
    if (!(await one(db.select().from(s.alertRules).where(eq(s.alertRules.id, id)))))
      throw Object.assign(new Error('告警规则不存在'), { statusCode: 404 });
    await run(db.update(s.alertRules).set(body).where(eq(s.alertRules.id, id)));
    await audit('alert-rule.update', id, body);
    return { ok: true };
  });
  app.patch('/api/alerts/:id', async (req) => {
    await run(
      db
        .update(s.alerts)
        .set({ status: 'acknowledged' })
        .where(eq(s.alerts.id, parseId(req))),
    );
    return { ok: true };
  });
  app.post('/api/settings', async (req) => {
    const body = z
      .object({ notificationAdapter: z.enum(['in_app']), note: z.string().max(500).default('') })
      .parse(req.body);
    await run(
      db
        .insert(s.settings)
        .values({ key: 'notifications', value: body })
        .onDuplicateKeyUpdate({ set: { value: body } }),
    );
    await audit('settings.update', 'notifications', body);
    return { ok: true };
  });
  app.get('/api/usage', async (req, reply) => {
    const q = range(req.query),
      paging = z
        .object({
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(20),
          search: z.string().max(200).default(''),
          format: z.enum(['json', 'csv']).default('json'),
        })
        .parse(req.query);
    const where = and(
      gte(s.usage.occurredAt, q.from),
      lt(s.usage.occurredAt, q.to),
      q.stationId ? eq(s.usage.stationId, q.stationId) : undefined,
      q.model ? eq(s.usage.model, q.model) : undefined,
      paging.search
        ? or(
            like(s.usage.model, `%${paging.search}%`),
            like(s.usage.requestId, `%${paging.search}%`),
          )
        : undefined,
    );
    const rows = await db.select().from(s.usage).where(where).orderBy(desc(s.usage.occurredAt));
    if (paging.format === 'csv') {
      const keys = [
        'id',
        'stationId',
        'requestId',
        'model',
        'input',
        'output',
        'cacheRead',
        'cacheCreation',
        'actualCost',
        'currency',
        'occurredAt',
        'priceId',
        'estimatedCost',
        'estimatedRevenue',
      ] as const;
      const cell = (x: any) =>
        `"${String(x ?? '')
          .replace(/^[=+@-]/, "'$&")
          .replaceAll('"', '""')}"`;
      reply.header('Content-Disposition', 'attachment; filename="usage.csv"');
      return reply
        .type('text/csv; charset=utf-8')
        .send(
          '\uFEFF' +
            [keys.join(','), ...rows.map((r) => keys.map((k) => cell(r[k])).join(','))].join(
              '\r\n',
            ),
        );
    }
    return {
      items: rows.slice((paging.page - 1) * paging.pageSize, paging.page * paging.pageSize),
      total: rows.length,
      page: paging.page,
      pageSize: paging.pageSize,
    };
  });
  const web = resolve('dist/web');
  if (existsSync(web)) {
    await app.register(fastifyStatic, { root: web });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/')
        ? reply.code(404).send({ message: '接口不存在' })
        : reply.sendFile('index.html'),
    );
  }
  app.addHook('onClose', async () => {
    if (!options.runtime) await runtime.close();
  });
  return { app, collector, runtime };
}
