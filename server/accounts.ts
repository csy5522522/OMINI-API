import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { Store } from './db.js';
import { run } from './db.js';
import * as s from './schema.js';
import type { Sub2ApiAdapter } from './adapter.js';
import { accountMetadata } from './checks.js';

export async function refreshAccounts(store: Store, stationId: string, adapter: Sub2ApiAdapter) {
  const items = await adapter.accounts();
  if (items.some((a) => !Number.isSafeInteger(a?.id) || a.id <= 0))
    throw Object.assign(new Error('账号列表缺少有效 ID，本次未覆盖已有数据'), { statusCode: 422 });
  const observedAt = new Date().toISOString();
  await store.db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(s.upstreamAccounts)
      .where(eq(s.upstreamAccounts.stationId, stationId));
    const keep = new Set(items.map((a) => String(a.id)));
    for (const a of existing)
      if (!keep.has(a.externalId))
        await run(tx.delete(s.upstreamAccounts).where(eq(s.upstreamAccounts.id, a.id)));
    for (const a of items) {
      const data = { ...accountMetadata(a), observedAt };
      await run(
        tx
          .insert(s.upstreamAccounts)
          .values({ id: randomUUID(), stationId, ...data })
          .onDuplicateKeyUpdate({ set: data }),
      );
    }
  });
  return items.length;
}
