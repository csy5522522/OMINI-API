import { afterAll, beforeAll, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { collectKeyMonitor, inspectKeyMonitor } from '../server/key-monitors.js';
import { decrypt, encrypt } from '../server/security.js';
import { testConfig, testStore, clearTestRedis, until } from './helpers.js';
import * as s from '../server/schema.js';

const config = testConfig();
let store: Awaited<ReturnType<typeof testStore>>, system: Awaited<ReturnType<typeof createApp>>;
let cookie = '',
  id = '',
  status = 200,
  amount = '8.25',
  currency = 'USD',
  balanceStatus = 200;
let pauseInFlight: (() => Promise<void>) | undefined;
const secret = 'secret-key-never-returned';
const headers = () => ({ cookie, 'x-requested-with': 'observatory' });
const remote = async (_base: string, path: string) => {
  if (pauseInFlight) {
    const callback = pauseInFlight;
    pauseInFlight = undefined;
    await callback();
  }
  return path.startsWith('/v1/usage')
    ? { status: balanceStatus, data: { balance: amount, unit: currency } }
    : { status, data: { data: [{ id: 'test-model' }, { id: secret }] } };
};
const post = (url: string, payload: any = {}, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') =>
  system.app.inject({ method, url, headers: headers(), payload });
const row = async () =>
  (await store.db.select().from(s.keyMonitors).where(eq(s.keyMonitors.id, id)))[0];
beforeAll(async () => {
  store = await testStore();
  system = await createApp(config, store, { remote });
  const login = await post('/api/login', {
    username: config.ADMIN_USERNAME,
    password: config.ADMIN_PASSWORD,
  });
  cookie = String(login.headers['set-cookie']).split(';')[0];
});
afterAll(async () => {
  await system.app.close();
  await clearTestRedis(config);
  await store.close();
});

it('监控需要登录，拒绝内网元数据地址及无效阈值', async () => {
  expect((await system.app.inject({ url: '/api/key-monitors' })).statusCode).toBe(401);
  const body = { name: 'test', baseUrl: 'http://169.254.169.254', key: secret };
  expect((await post('/api/key-monitors', body)).statusCode).toBe(400);
  expect((await post('/api/key-monitors', { ...body, balanceThreshold: '-1' })).statusCode).toBe(
    400,
  );
});
it('保存加密 Key，仅返回脱敏值，队列只保存 ID', async () => {
  const result = await post('/api/key-monitors', {
    name: 'test',
    baseUrl: 'http://127.0.0.1:1234/v1',
    key: secret,
    balanceEnabled: true,
    balanceThreshold: '10',
  });
  expect(result.statusCode).toBe(201);
  id = result.json().id;
  expect(result.body).not.toContain(secret);
  expect(result.body).not.toContain('encrypted');
  expect(decrypt((await row()).encrypted, config.ENCRYPTION_KEY)).toBe(secret);
  expect((await system.runtime.queue.getJob(`key-${id}`))?.data).toEqual({ monitorId: id });
});
it('余额低于阈值提醒，重复采集不重复告警，恢复自动关闭', async () => {
  await collectKeyMonitor(store, config, id, remote);
  await collectKeyMonitor(store, config, id, remote);
  expect(await store.db.select().from(s.alerts)).toHaveLength(1);
  expect((await row()).result?.balance).toMatchObject({ amount: '8.25', currency: 'USD' });
  expect((await row()).incident).toBe('low_balance');
  amount = '20';
  await collectKeyMonitor(store, config, id, remote);
  expect((await row()).incident).toBeNull();
  expect((await store.db.select().from(s.alerts))[0].status).toBe('resolved');
});
it('401 会更新认证状态并清空余额，响应及审计不泄漏 Key', async () => {
  status = 401;
  await collectKeyMonitor(store, config, id, remote);
  expect((await row()).result).toMatchObject({ status: 'unauthorized', balance: { amount: null } });
  const response = await system.app.inject({ url: '/api/key-monitors', headers: headers() });
  expect(response.body).not.toContain(secret);
  expect(response.body).not.toContain('encrypted');
  expect(JSON.stringify(await store.db.select().from(s.audit))).not.toContain(secret);
});
it('余额不支持或币种不同，不误报 Key 无效或低余额', async () => {
  status = 200;
  balanceStatus = 404;
  await collectKeyMonitor(store, config, id, remote);
  expect((await row()).result).toMatchObject({
    status: 'supported',
    balance: { status: 'unsupported', amount: null },
  });
  expect((await row()).incident).toBeNull();
  balanceStatus = 200;
  currency = 'CNY';
  amount = '1';
  await collectKeyMonitor(store, config, id, remote);
  expect((await row()).incident).toBeNull();
  currency = 'TOKENS';
  await collectKeyMonitor(store, config, id, remote);
  expect((await row()).result?.balance.status).toBe('unavailable');
  currency = 'USD';
  amount = '20';
});
it('暂停与编辑不会被旧检测覆盖，局部更新保留其他设置', async () => {
  pauseInFlight = async () => {
    expect((await post(`/api/key-monitors/${id}`, { enabled: false }, 'PATCH')).statusCode).toBe(
      200,
    );
  };
  await collectKeyMonitor(store, config, id, remote);
  expect((await row()).enabled).toBe(false);
  expect((await row()).result).toBeNull();
  expect((await row()).balanceEnabled).toBe(true);
  expect((await row()).balanceThreshold).toBe('10.000000000000');
  expect((await post(`/api/key-monitors/${id}/refresh`)).statusCode).toBe(409);
  await post(`/api/key-monitors/${id}`, { enabled: true, key: 'replacement-key' }, 'PATCH');
  expect(decrypt((await row()).encrypted, config.ENCRYPTION_KEY)).toBe('replacement-key');
  await post(`/api/key-monitors/${id}`, { key: secret }, 'PATCH');
});
it('真实 worker 定时扫描、跨实例去重，手动刷新等待检测完成', async () => {
  // Exercise scheduled discovery without the create-time job.
  await (await system.runtime.queue.getJob(`key-${id}`))?.remove();
  await system.runtime.startWorkers();
  await until(async () => Boolean((await row()).checkedAt));
  const responses = await Promise.all([
    post(`/api/key-monitors/${id}/refresh`),
    post(`/api/key-monitors/${id}/refresh`),
  ]);
  for (const response of responses) {
    expect(response.statusCode).toBe(200);
    expect(response.json().result.status).toBe('supported');
    expect(response.body).not.toContain(secret);
    expect(response.json().result.models).toContain('[REDACTED]');
  }
});
it('已有站点 Key 可直接导入，移除监控不撤销站点凭证', async () => {
  await store.db
    .insert(s.stations)
    .values({
      id: 'source',
      name: 'source',
      baseUrl: 'http://127.0.0.1:1234',
      kind: 'third_party',
      authType: 'api_key',
      role: 'cost',
      createdAt: new Date().toISOString(),
    });
  await store.db
    .insert(s.credentials)
    .values({
      stationId: 'source',
      encrypted: encrypt(secret, config.ENCRYPTION_KEY),
      masked: 'masked',
    });
  const imported = await post('/api/key-monitors/import', { stationId: 'source' });
  expect(imported.statusCode).toBe(201);
  expect(imported.body).not.toContain(secret);
  expect((await post(`/api/key-monitors/${imported.json().id}`, {}, 'DELETE')).statusCode).toBe(
    200,
  );
  expect(await store.db.select().from(s.credentials)).toHaveLength(1);
});
it('三种协议使用对应认证头，非金额余额不显示', async () => {
  for (const protocol of ['openai', 'anthropic', 'gemini'] as const) {
    const result = await inspectKeyMonitor(
      { baseUrl: 'https://api.example.com', protocol, balanceEnabled: false, currency: 'USD' },
      secret,
      [],
      async (_base, path, auth) => {
        expect(
          auth[
            protocol === 'openai'
              ? 'authorization'
              : protocol === 'anthropic'
                ? 'x-api-key'
                : 'x-goog-api-key'
          ],
        ).toBe(protocol === 'openai' ? `Bearer ${secret}` : secret);
        expect(path).toBe(protocol === 'gemini' ? '/v1beta/models' : '/v1/models');
        return {
          status: 200,
          data:
            protocol === 'gemini'
              ? { models: [{ name: 'test-model' }] }
              : { data: [{ id: 'test-model' }] },
        };
      },
    );
    expect(result.status).toBe('supported');
  }
});
