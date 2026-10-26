import { it, expect } from 'vitest';
import { Sub2ApiAdapter } from '../server/adapter.js';
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
