import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { testConfig, testStore, clearTestRedis } from './helpers.js';
import * as s from '../server/schema.js';

const config = testConfig();
let store: Awaited<ReturnType<typeof testStore>>;
let system: Awaited<ReturnType<typeof createApp>>;
let cookie = '',
  id = '',
  balance: unknown = '9.25',
  status = 200;
const headers = () => ({ cookie, 'x-requested-with': 'observatory' });
beforeAll(async () => {
  store = await testStore();
  system = await createApp(config, store, {
    remote: async (_base, path) =>
      path.startsWith('/v1/usage')
        ? { status, data: { balance, unit: 'USD', daily_usage: [] } }
        : { status: 404, data: {} },
  });
  const login = await system.app.inject({
    method: 'POST',
    url: '/api/login',
    headers: headers(),
    payload: {
      username: config.ADMIN_USERNAME,
      password: config.ADMIN_PASSWORD,
    },
  });
  cookie = String(login.headers['set-cookie']).split(';')[0];
});
afterAll(async () => {
  await system.app.close();
  await clearTestRedis(config);
  await store.close();
});
it('保存余额监控原子创建加密凭证、三类告警并入队首次采集', async () => {
  const r = await system.app.inject({
    method: 'POST',
    url: '/api/stations',
    headers: headers(),
    payload: {
      name: 'balance monitor',
      baseUrl: 'http://127.0.0.1:1234',
      kind: 'third_party',
      authType: 'api_key',
      credential: 'test-balance-secret',
      balanceThreshold: '10',
      costMode: 'prepaid',
    },
  });
  expect(r.statusCode).toBe(201);
  id = r.json().id;
  expect((await store.db.select().from(s.credentials))[0].encrypted).not.toContain(
    'test-balance-secret',
  );
  const rules = await store.db.select().from(s.alertRules);
  expect(rules.map((r) => r.type).sort()).toEqual(['auth', 'balance', 'sync']);
  expect(rules.every((r) => r.stationId === id && r.enabled)).toBe(true);
  expect(await system.runtime.queue.getWaitingCount()).toBeGreaterThanOrEqual(1);
});
it('低余额只提醒一次，阈值可修改，恢复后不再新增告警', async () => {
  await system.collector.start(id, true);
  await system.collector.start(id, true);
  let alerts = await store.db.select().from(s.alerts);
  expect(alerts).toHaveLength(1);
  expect(alerts[0].message).toContain('9.25 USD');
  const rule = (await store.db.select().from(s.alertRules)).find((r) => r.type === 'balance')!;
  const r = await system.app.inject({
    method: 'PATCH',
    url: `/api/alert-rules/${rule.id}`,
    headers: headers(),
    payload: { threshold: '5', cooldown: 7200 },
  });
  expect(r.statusCode).toBe(200);
  expect(
    (await store.db.select().from(s.alertRules).where(eq(s.alertRules.id, rule.id)))[0].threshold,
  ).toBe('5.000000000000');
  balance = '20';
  await system.collector.start(id, true);
  expect(await store.db.select().from(s.alerts)).toHaveLength(1);
  expect((await store.db.select().from(s.stations))[0].snapshot?.balance).toBe('20');
});
it('欠费余额触发告警；401 清除失效余额并提醒认证与采集失败', async () => {
  await store.db.delete(s.alerts);
  balance = -0.25;
  await system.collector.start(id, true);
  expect((await store.db.select().from(s.alerts))[0].type).toBe('balance');
  status = 401;
  await system.collector.start(id, true);
  const station = (await store.db.select().from(s.stations))[0];
  expect(station.status).toBe('unauthorized');
  expect(station.snapshot?.balance).toBeUndefined();
  expect((await store.db.select().from(s.alerts)).map((a) => a.type).sort()).toEqual([
    'auth',
    'balance',
    'sync',
  ]);
  const response = await system.app.inject({ url: '/api/state', headers: headers() });
  expect(response.body).not.toContain('test-balance-secret');
});
