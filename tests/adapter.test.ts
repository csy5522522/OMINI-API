import { it, expect } from 'vitest';
import { Sub2ApiAdapter } from '../server/adapter.js';
it('F-AI Hub 只读 usage 返回账户余额且不发起生成请求', async () => {
  const paths: string[] = [];
  const adapter = new Sub2ApiAdapter(
    'https://mock.invalid',
    'api_key',
    'fake',
    [],
    async (_base, path, headers) => {
      paths.push(path);
      expect(headers.authorization).toBe('Bearer fake');
      return path.startsWith('/v1/usage')
        ? {
            status: 200,
            data: {
              balance: 16.08116317,
              remaining: 16.08116317,
              unit: 'USD',
              mode: 'unrestricted',
              daily_usage: [],
            },
          }
        : { status: 404, data: {} };
    },
  );
  const result = await adapter.probe();
  expect(result.payloads.balance.balance).toBe(16.08116317);
  expect(result.caps.balance.status).toBe('supported');
  expect(paths.filter((p) => p.startsWith('/v1/usage'))).toHaveLength(1);
  expect(paths.every((p) => /^\/v1\/(usage|models|sub2api\/billing)/.test(p))).toBe(true);
});
it('网页登录余额优先 auth/me，仅在 404 时兼容 user/profile', async () => {
  for (const status of [200, 401, 403, 404]) {
    const paths: string[] = [];
    const adapter = new Sub2ApiAdapter(
      'https://mock.invalid',
      'user_jwt',
      'fake',
      [],
      async (_base, path) => {
        paths.push(path);
        if (path === '/api/v1/auth/me')
          return { status, data: { code: 0, data: { balance: '0' } } };
        if (path === '/api/v1/user/profile')
          return { status: 200, data: { code: 0, data: { balance: '16.52863742' } } };
        return { status: 404, data: {} };
      },
    );
    const r = await adapter.probe();
    expect(paths.includes('/api/v1/user/profile')).toBe(status === 404);
    expect(r.caps.balance.status).toBe(
      status === 200 || status === 404
        ? 'supported'
        : status === 401
          ? 'unauthorized'
          : 'forbidden',
    );
  }
});
it('空值与非法余额不能作为真实余额，零余额和欠费有效', async () => {
  for (const balance of [null, '', false, 'bad', 0, -1, '0.00000001']) {
    const a = new Sub2ApiAdapter('https://mock.invalid', 'user_jwt', 'fake', [], async () => ({
      status: 200,
      data: { balance },
    }));
    const r = await a.probe();
    expect(r.caps.balance.status).toBe(
      [0, -1, '0.00000001'].includes(balance as any) ? 'supported' : 'unavailable',
    );
  }
});
it('403、404、429 与契约不匹配分别降级，部分失败不阻断其他能力', async () => {
  let retry = 0;
  const adapter = new Sub2ApiAdapter(
    'https://mock.invalid',
    'admin_key',
    'fake',
    [],
    async (_base, path, headers) => {
      expect(headers['x-api-key']).toBe('fake');
      if (path.includes('accounts')) return { status: 403, data: {} };
      if (path.includes('model-pricing')) return { status: 404, data: {} };
      if (path.includes('realtime')) {
        retry++;
        return { status: 429, data: {} };
      }
      if (path.includes('stats')) return { status: 200, data: { total_requests: 3 } };
      return { status: 200, data: { wrong: 'format' } };
    },
  );
  const result = await adapter.probe();
  expect(result.caps.accounts.status).toBe('forbidden');
  expect(result.caps.prices.status).toBe('unsupported');
  expect(result.caps.realtime.status).toBe('rate_limited');
  expect(result.caps.logs.status).toBe('unavailable');
  expect(result.caps.tokens.status).toBe('supported');
  expect(retry).toBe(3);
});
it('网络失败最多尝试三次，错误消息不泄露凭证', async () => {
  let count = 0;
  const adapter = new Sub2ApiAdapter(
    'https://mock.invalid',
    'user_jwt',
    'never-leak',
    [],
    async () => {
      count++;
      throw new Error('never-leak');
    },
  );
  await expect(adapter.call('/api/v1/usage')).rejects.toThrow('网络连接失败');
  expect(count).toBe(3);
});
