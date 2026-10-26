import { one, run } from './db.js';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { eq, desc } from 'drizzle-orm';
import { z } from 'zod';
import { Decimal } from '../shared/finance.js';
import type { Store } from './db.js';
import { fxRates, audit } from './schema.js';
import { safeGet } from './security.js';
import type { RemoteGet } from './adapter.js';
const source = 'https://www.exchangerate-api.com';
const payload = z.object({
  result: z.literal('success'),
  base_code: z.literal('USD'),
  time_last_update_unix: z.number().int().positive(),
  rates: z.object({
    USD: z.number().positive(),
    CNY: z.number().positive(),
    EUR: z.number().positive(),
    AED: z.number().positive(),
  }),
});
export async function syncExchange(store: Store, provider: string, get: RemoteGet = safeGet) {
  if (provider !== 'open_er')
    throw Object.assign(
      new Error('未启用真实汇率来源；请设置 FX_PROVIDER=open_er，或手动录入有依据的汇率'),
      { statusCode: 422 },
    );
  const { db } = store,
    last = await one(
      db
        .select()
        .from(fxRates)
        .where(eq(fxRates.source, source))
        .orderBy(desc(fxRates.effectiveAt)),
    );
  if (last && Date.now() - Date.parse(last.effectiveAt) < 864e5)
    return { message: '沿用提供商日度汇率缓存', cached: true };
  const r = await get('https://open.er-api.com', '/v6/latest/USD', {}, []);
  if (r.status !== 200)
    throw Object.assign(new Error(`汇率提供商返回 HTTP ${r.status}`), { statusCode: 502 });
  const data = payload.parse(r.data),
    effectiveAt = new Date(data.time_last_update_unix * 1000).toISOString();
  if (
    Date.parse(effectiveAt) > Date.now() + 300000 ||
    Date.now() - Date.parse(effectiveAt) > 3 * 864e5
  )
    throw Object.assign(new Error('提供商汇率时间异常或已过期'), { statusCode: 502 });
  if (last?.effectiveAt === effectiveAt) return { message: '提供商尚未更新汇率', cached: true };
  await db.transaction(async (tx) => {
    for (const from of ['USD', 'CNY', 'EUR', 'AED'] as const)
      for (const to of ['USD', 'CNY', 'EUR', 'AED'] as const) {
        if (from === to) continue;
        await run(
          tx.insert(fxRates).values({
            id: randomUUID(),
            from,
            to,
            rate: new Decimal(String(data.rates[to])).div(String(data.rates[from])).toFixed(12),
            effectiveAt,
            source,
          }),
        );
      }
    await run(
      tx.insert(audit).values({
        id: randomUUID(),
        action: 'exchange-rate.sync',
        entityId: provider,
        details: { source, effectiveAt },
        createdAt: new Date().toISOString(),
      }),
    );
  });
  return { message: '已保存真实日度汇率及历史版本', cached: false, effectiveAt };
}
