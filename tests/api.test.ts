import { one, run } from '../server/db.js';
import { sql } from 'drizzle-orm';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { createApp } from '../server/app.js';
import { openDatabase } from '../server/db.js';
import type { Config } from '../server/config.js';
import { testConfig, testStore, clearTestRedis } from './helpers.js';
import { mockSub2Api } from './mock-sub2api.js';
import { stations, usage, credentials } from '../server/schema.js';
import { eq } from 'drizzle-orm';
describe('独立 Mock HTTP 服务集成（非真实站点）', () => {
  let mock: Awaited<ReturnType<typeof mockSub2Api>>,
    system: Awaited<ReturnType<typeof createApp>>,
    store: Awaited<ReturnType<typeof openDatabase>>,
    config: Config,
    session = '',
    down = '',
    up = '',
    key = '';
  const headers = () => ({ 'x-requested-with': 'observatory', cookie: session });
  const post = (url: string, payload: any) =>
    system.app.inject({ method: 'POST', url, headers: headers(), payload });
  const sync = async (id: string, force = true) => {
    const result = await system.collector.start(id, force);
    await system.runtime.invalidate();
    return result;
  };
  beforeAll(async () => {
    mock = await mockSub2Api();
    store = await testStore();
    config = testConfig();
    system = await createApp(config, store);
  });
  afterAll(async () => {
    await system.app.close();
    await mock.app.close();
    await clearTestRedis(config);
    await store.close();
  });
  it('未登录禁止访问，跨站写入禁止', async () => {
    expect((await system.app.inject('/api/state')).statusCode).toBe(401);
    expect(
      (
        await system.app.inject({
          method: 'POST',
          url: '/api/login',
          payload: { username: 'admin', password: 'test-password-long' },
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await system.app.inject({
          method: 'POST',
          url: '/api/login',
          headers: { 'x-requested-with': 'observatory', origin: 'https://evil.example' },
          payload: { username: 'admin', password: 'test-password-long' },
        })
      ).statusCode,
    ).toBe(403);
  });
  it('本系统认证使用签名 HttpOnly 会话', async () => {
    const r = await post('/api/login', { username: 'admin', password: 'test-password-long' });
    expect(r.statusCode).toBe(200);
    session = String(r.headers['set-cookie']).split(';')[0];
    expect(String(r.headers['set-cookie'])).toContain('HttpOnly');
    expect((await system.app.inject({ url: '/api/me', headers: headers() })).statusCode).toBe(200);
  });
  it('添加三种权限站点，凭证加密且响应不泄露', async () => {
    for (const [authType, credential, role, kind] of [
      ['admin_key', 'admin-secret', 'sales', 'self'],
      ['user_jwt', 'user-secret', 'cost', 'third_party'],
      ['api_key', 'model-secret', 'cost', 'third_party'],
    ]) {
      const r = await post('/api/stations', {
        name: authType,
        baseUrl: mock.url,
        authType,
        credential,
        role,
        kind,
        costMode: 'token',
      });
      expect(r.statusCode).toBe(201);
      if (authType === 'admin_key') down = r.json().id;
      else if (authType === 'user_jwt') up = r.json().id;
      else key = r.json().id;
    }
    expect(
      (await store.db.select().from(credentials)).every((c) => !c.encrypted.includes('secret')),
    ).toBe(true);
  });
  it('真实 HTTP 采集、权限隔离、缺失能力降级和敏感字段过滤', async () => {
    await sync(down, true);
    await sync(up, true);
    await sync(key, true);
    const result = await system.app.inject({ url: '/api/state', headers: headers() });
    expect(result.statusCode).toBe(200);
    expect(result.body).not.toContain('MUST-NOT-LEAK');
    expect(result.body).not.toContain('private@example.com');
    expect(result.body).not.toContain('admin-secret');
    const data = result.json();
    expect(
      data.stations
        .find((x: any) => x.id === key)
        .capabilities.find((x: any) => x.name === 'billing').status,
    ).toBe('unsupported');
    expect(data.stations.find((x: any) => x.id === down).snapshot.accounts[0].schedulable).toBe(
      true,
    );
    expect(
      mock.calls
        .filter((c) => c.auth === 'Bearer model-secret')
        .every((c) => c.path.startsWith('/v1/')),
    ).toBe(true);
    expect(
      mock.calls
        .filter((c) => c.auth === 'Bearer user-secret')
        .every((c) => !c.path.includes('/admin/')),
    ).toBe(true);
  });
  it('只允许一个主中转，第三方自动归入采购核算且不能修改站点类型或角色', async () => {
    const duplicate = await post('/api/stations', {
      name: 'second-main',
      baseUrl: mock.url,
      kind: 'self',
      authType: 'admin_key',
      credential: 'admin-secret',
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().message).toContain('只能配置一个主中转站');
    expect(
      (
        await post('/api/stations', {
          name: 'wrong-main-auth',
          baseUrl: mock.url,
          kind: 'self',
          authType: 'api_key',
          credential: 'model-secret',
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await post('/api/stations', {
          name: 'wrong-third-auth',
          baseUrl: mock.url,
          kind: 'third_party',
          authType: 'admin_key',
          credential: 'admin-secret',
        })
      ).statusCode,
    ).toBe(400);
    const third = await post('/api/stations', {
      name: 'third-with-forged-sales-role',
      baseUrl: mock.url,
      kind: 'third_party',
      authType: 'api_key',
      credential: 'model-secret',
      role: 'sales',
    });
    expect(third.statusCode).toBe(201);
    expect(
      (await one(store.db.select().from(stations).where(eq(stations.id, third.json().id))))?.role,
    ).toBe('cost');
    for (const payload of [{ role: 'sales' }, { kind: 'self' }])
      expect(
        (
          await system.app.inject({
            method: 'PATCH',
            url: `/api/stations/${up}`,
            headers: headers(),
            payload,
          })
        ).statusCode,
      ).toBe(400);
    expect((await store.db.select().from(stations)).filter((x) => x.kind === 'self')).toHaveLength(
      1,
    );
  });
  it('增量重试不重复导入，相同请求可靠关联后只统计根站点', async () => {
    await sync(down, true);
    expect(await store.db.select().from(usage).where(eq(usage.stationId, down))).toHaveLength(1);
    const rel = await post('/api/relations', { downstreamId: down, upstreamId: up });
    expect(rel.statusCode).toBe(201);
    const result = (await system.app.inject({ url: '/api/state', headers: headers() })).json();
    expect(result.correlations).toHaveLength(1);
    expect(result.report.summary.requests).toBe(1);
    expect(result.report.summary.successRate).toBeNull();
    expect(result.report.finances.find((x: any) => x.currency === 'USD').profit).toBe('3.00000000');
    expect(result.report.summary.pending).toBe(0);
    expect((await post('/api/relations', { downstreamId: up, upstreamId: down })).statusCode).toBe(
      400,
    );
  });
  it('保存价格版本不重算历史记录，支持官方价读取和精确计算 API', async () => {
    const rates = { input: '2', output: '8', cacheRead: '0.2', cacheCreation: '2.5' };
    const p = await post('/api/prices', {
      stationId: down,
      model: 'test-model',
      currency: 'USD',
      buy: rates,
      sell: rates,
      multiplier: '1',
      effectiveAt: '2020-01-01T00:00:00Z',
    });
    expect(p.statusCode).toBe(201);
    await sync(down, true);
    expect(
      (await one(store.db.select().from(usage).where(eq(usage.stationId, down))))?.priceId,
    ).toBeNull();
    const price = await post(`/api/stations/${down}/import-price`, { model: 'test-model' });
    expect(price.json().rates.input).toBe('2');
    const calc = await post('/api/calculator', {
      tokens: { input: 1000000, output: 0, cacheRead: 0, cacheCreation: 0 },
      buy: rates,
      sell: { ...rates, input: '3' },
      multiplier: '1',
      fx: '1',
    });
    expect(calc.json().profit).toBe('1.00000000');
    expect(calc.json().classification).toBe('estimate');
  });
  it('充值不确认为成本、收入，固定订阅单独摊销', async () => {
    expect(
      (
        await post('/api/recharges', {
          stationId: up,
          amount: '100',
          currency: 'USD',
          occurredAt: new Date().toISOString(),
          note: 'Mock prepaid',
        })
      ).statusCode,
    ).toBe(201);
    const before = (await system.app.inject({ url: '/api/state', headers: headers() })).json();
    expect(before.report.finances[0].cost).toBe('2.00000000');
    const d = new Date();
    const start = new Date(d.getTime() - 864e5),
      end = new Date(d.getTime() + 864e5);
    expect(
      (
        await post('/api/subscriptions', {
          stationId: up,
          name: 'Mock subscription',
          amount: '20',
          otherFees: '0',
          currency: 'EUR',
          start: start.toISOString(),
          end: end.toISOString(),
        })
      ).statusCode,
    ).toBe(201);
    const after = (await system.app.inject({ url: '/api/state', headers: headers() })).json();
    expect(after.report.finances.find((f: any) => f.currency === 'EUR')).toBeTruthy();
    expect(after.report.finances.find((f: any) => f.currency === 'USD').cost).toBe('2.00000000');
  });
  it('CSV 正常导出，敏感凭证不进入明细', async () => {
    const r = await system.app.inject({ url: '/api/usage?format=csv', headers: headers() });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('text/csv');
    expect(r.body).toContain('test-model');
    expect(r.body).not.toContain('MUST-NOT-LEAK');
  });
  it('额外交易保留录入时汇率引用，后续汇率更新不重写历史交易', async () => {
    const old = await post('/api/exchange-rates', {
      from: 'EUR',
      to: 'USD',
      rate: '1.1',
      effectiveAt: '2020-01-01T00:00:00Z',
      source: 'Mock historical rate',
    });
    expect(old.statusCode).toBe(201);
    const tr = await post('/api/transactions', {
      stationId: up,
      kind: 'other',
      amount: '1',
      currency: 'EUR',
      occurredAt: new Date().toISOString(),
      note: 'Mock extra cost',
    });
    expect(tr.statusCode).toBe(201);
    await post('/api/exchange-rates', {
      from: 'EUR',
      to: 'USD',
      rate: '1.2',
      effectiveAt: '2021-01-01T00:00:00Z',
      source: 'Mock changed rate',
    });
    const state = (await system.app.inject({ url: '/api/state', headers: headers() })).json();
    expect(state.transactions.find((x: any) => x.id === tr.json().id).fxId).toBe(old.json().id);
  });
  it('401 与 403 清晰分类；告警遵守冷却窗口', async () => {
    const r = await post('/api/stations', {
      name: 'expired',
      baseUrl: mock.url,
      authType: 'user_jwt',
      credential: 'expired',
      kind: 'third_party',
      role: 'observe',
    });
    const id = r.json().id;
    expect(
      (
        await post('/api/alert-rules', {
          stationId: id,
          type: 'auth',
          threshold: '0',
          cooldown: 3600,
          enabled: true,
        })
      ).statusCode,
    ).toBe(201);
    await sync(id, true);
    await sync(id, true);
    const state = (await system.app.inject({ url: '/api/state', headers: headers() })).json();
    expect(state.stations.find((x: any) => x.id === id).status).toBe('unauthorized');
    expect(state.alerts.filter((x: any) => x.stationId === id)).toHaveLength(1);
  });
});
