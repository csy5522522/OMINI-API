import { one, run } from '../server/db.js';
import { sql } from 'drizzle-orm';
import { it, expect } from 'vitest';
import { syncExchange } from '../server/exchange.js';
import { testStore } from './helpers.js';
import { fxRates } from '../server/schema.js';
it('真实来源自动汇率适配：模拟响应、日度缓存、保留历史、不虚构未配置来源', async () => {
  const store = await testStore();
  let calls = 0;
  const get = async () => {
    calls++;
    return {
      status: 200,
      data: {
        result: 'success',
        base_code: 'USD',
        time_last_update_unix: Math.floor(Date.now() / 1000),
        rates: { USD: 1, CNY: 7, EUR: 0.9, AED: 3.67 },
      },
    };
  };
  await expect(syncExchange(store, 'none', get)).rejects.toThrow('未启用');
  await syncExchange(store, 'open_er', get);
  expect(await store.db.select().from(fxRates)).toHaveLength(12);
  await syncExchange(store, 'open_er', get);
  expect(calls).toBe(1);
  await store.close();
});
