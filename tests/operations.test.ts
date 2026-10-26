import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { eq } from 'drizzle-orm';
import { createApp } from '../server/app.js';
import { testConfig, testStore, clearTestRedis } from './helpers.js';
import * as s from '../server/schema.js';

describe('账号、Key 检测与 MCP 端到端', () => {
  const config = testConfig();
  let store: Awaited<ReturnType<typeof testStore>>, system: Awaited<ReturnType<typeof createApp>>;
  const remote = Fastify();
  let session = '',
    stationId = '',
    accountId = '',
    token = '',
    keyId = '',
    failList = false;
  let accountRows = Array.from({ length: 101 }, (_, i) => ({
    id: i + 1,
    name: `account-${i + 1}`,
    platform: 'openai',
    type: i % 2 ? 'oauth' : 'apikey',
    status: 'active',
    credentials: { base_url: 'https://upstream.example/v1', api_key: 'MUST-NOT-LEAK' },
    credentials_status: { has_api_key: true },
    schedulable: true,
  }));
  const headers = () => ({ cookie: session, 'x-requested-with': 'observatory' });
  const post = (url: string, payload: any) =>
    system.app.inject({ method: 'POST', url, headers: headers(), payload });
  const rpc = (method: string, params?: any, id: number | undefined = 1, bearer = token) =>
    system.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${bearer}` },
      payload: {
        jsonrpc: '2.0',
        method,
        ...(params === undefined ? {} : { params }),
        ...(id === undefined ? {} : { id }),
      },
    });
  beforeAll(async () => {
    remote.get('/api/v1/admin/accounts', async (req, reply) => {
      expect(req.headers['x-api-key']).toBe('admin-secret');
      const page = Number((req.query as any).page);
      if (failList && page === 2) return reply.code(403).send({ message: 'MUST-NOT-LEAK' });
      return {
        code: 0,
        data: { items: accountRows.slice((page - 1) * 100, page * 100), total: accountRows.length },
      };
    });
    remote.post('/api/v1/admin/accounts/:id/test', async (req, reply) => {
      expect(req.headers['x-api-key']).toBe('admin-secret');
      return reply
        .type('text/event-stream')
        .send(
          'data: {"type":"content","text":"MUST-NOT-LEAK"}\n\ndata: {"type":"test_complete","success":true}\n\n',
        );
    });
    remote.get('/v1/models', async (req, reply) =>
      req.headers.authorization === 'Bearer test-model-key'
        ? { data: [{ id: 'test-model' }] }
        : reply.code(401).send({ error: 'MUST-NOT-LEAK' }),
    );
    await remote.listen({ host: '127.0.0.1', port: 0 });
    store = await testStore();
    system = await createApp(config, store);
    const login = await post('/api/login', {
      username: config.ADMIN_USERNAME,
      password: config.ADMIN_PASSWORD,
    });
    session = String(login.headers['set-cookie']).split(';')[0];
    const station = await post('/api/stations', {
      kind: 'self',
      name: 'main',
      baseUrl: `http://127.0.0.1:${(remote.server.address() as any).port}`,
      authType: 'admin_key',
      credential: 'admin-secret',
    });
    expect(station.statusCode).toBe(201);
    stationId = station.json().id;
  });
  afterAll(async () => {
    await system?.app.close();
    await remote.close();
    await clearTestRedis(config);
    await store?.close();
  });
  it('获取完整账号列表，原始凭证不进入数据库与响应', async () => {
    expect((await post('/api/accounts/refresh', {})).json().count).toBe(101);
    const result = await system.app.inject({ url: '/api/accounts', headers: headers() });
    expect(result.json()).toHaveLength(101);
    expect(result.body).not.toContain('MUST-NOT-LEAK');
    const rows = await store.db.select().from(s.upstreamAccounts);
    expect(JSON.stringify(rows)).not.toContain('MUST-NOT-LEAK');
    expect(rows.every((a) => a.keyPresent && a.stationId === stationId)).toBe(true);
    accountId = rows[0].id;
  });
  it('账号测试经过管理员代理，要求用量确认并保存脱敏测试结果', async () => {
    expect((await post(`/api/accounts/${accountId}/check`, {})).statusCode).toBe(400);
    const result = await post(`/api/accounts/${accountId}/check`, { acknowledgeUsage: true });
    expect(result.json().status).toBe('supported');
    expect(result.body).not.toContain('MUST-NOT-LEAK');
    expect(
      (
        await store.db.select().from(s.upstreamAccounts).where(eq(s.upstreamAccounts.id, accountId))
      )[0].checkResult?.status,
    ).toBe('supported');
  });
  it('分页失败保留所有已有账号和测试结果', async () => {
    failList = true;
    expect((await post('/api/accounts/refresh', {})).statusCode).toBe(422);
    expect(await store.db.select().from(s.upstreamAccounts)).toHaveLength(101);
    failList = false;
    expect((await post('/api/accounts/refresh', {})).statusCode).toBe(200);
    expect(
      (
        await store.db.select().from(s.upstreamAccounts).where(eq(s.upstreamAccounts.id, accountId))
      )[0].checkResult?.status,
    ).toBe('supported');
  });
  it('临时 Key 检测返回真实模型列表与 401 分类，不存储输入 Key', async () => {
    const baseUrl = `http://127.0.0.1:${(remote.server.address() as any).port}/v1`;
    expect(
      (await post('/api/keys/check', { baseUrl, key: 'test-model-key' })).json().models,
    ).toEqual(['test-model']);
    const bad = await post('/api/keys/check', { baseUrl, key: 'bad-key' });
    expect(bad.json().status).toBe('unauthorized');
    expect(bad.body).not.toContain('MUST-NOT-LEAK');
    expect(JSON.stringify(await store.db.select().from(s.audit))).not.toContain('test-model-key');
    expect(
      (await post('/api/keys/check', { baseUrl: 'http://169.254.169.254', key: 'key' })).statusCode,
    ).toBeGreaterThanOrEqual(400);
  });
  it('MCP Key 仅首次返回原文，管理列表和数据库均不保存原文', async () => {
    const created = await post('/api/mcp/keys', { name: 'test client', days: 7 });
    expect(created.statusCode).toBe(201);
    token = created.json().token;
    keyId = created.json().id;
    const list = await system.app.inject({ url: '/api/mcp/keys', headers: headers() });
    expect(list.body).not.toContain(token);
    expect(list.body).not.toContain('tokenHash');
    expect(JSON.stringify(await store.db.select().from(s.mcpKeys))).not.toContain(token);
    expect((await rpc('ping', {}, 1, 'bad')).statusCode).toBe(401);
  });
  it('MCP 初始化、通知、工具目录和分页账号调用可完成，参数与未知工具返回标准错误', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(init.json().result.protocolVersion).toBe('2025-11-25');
    // Pass undefined directly, rather than the helper default, for a notification.
    const notification = await system.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}` },
      payload: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(notification.statusCode).toBe(202);
    expect(notification.body).toBe('');
    expect((await rpc('tools/list')).json().result.tools).toHaveLength(3);
    const accounts = await rpc('tools/call', {
      name: 'list_accounts',
      arguments: { page: 2, pageSize: 100 },
    });
    const data = JSON.parse(accounts.json().result.content[0].text);
    expect(data.total).toBe(101);
    expect(data.items).toHaveLength(1);
    expect(accounts.body).not.toContain('MUST-NOT-LEAK');
    expect(
      (await rpc('tools/call', { name: 'get_overview', arguments: { period: '3' } })).json().result
        .content,
    ).toHaveLength(1);
    expect(
      (await rpc('tools/call', { name: 'list_accounts', arguments: { pageSize: 1000 } })).json()
        .error.code,
    ).toBe(-32602);
    expect((await rpc('tools/call', { name: 'check_key' })).json().error.code).toBe(-32602);
    expect((await rpc('missing')).json().error.code).toBe(-32601);
  });
  it('MCP 拒绝跨站 Origin、GET、到期或已撤销的密钥', async () => {
    const cross = await system.app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' },
      payload: { jsonrpc: '2.0', id: 1, method: 'ping' },
    });
    expect(cross.statusCode).toBe(403);
    expect(
      (await system.app.inject({ url: '/mcp', headers: { authorization: `Bearer ${token}` } }))
        .statusCode,
    ).toBe(405);
    await store.db
      .update(s.mcpKeys)
      .set({ expiresAt: '2000-01-01T00:00:00.000Z' })
      .where(eq(s.mcpKeys.id, keyId));
    expect((await rpc('ping')).statusCode).toBe(401);
    await store.db
      .update(s.mcpKeys)
      .set({ expiresAt: '2099-01-01T00:00:00.000Z' })
      .where(eq(s.mcpKeys.id, keyId));
    expect(
      (
        await system.app.inject({
          method: 'DELETE',
          url: `/api/mcp/keys/${keyId}`,
          headers: headers(),
        })
      ).statusCode,
    ).toBe(200);
    expect((await rpc('ping')).statusCode).toBe(401);
  });
});
