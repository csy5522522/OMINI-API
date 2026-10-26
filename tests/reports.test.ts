import { one, run } from '../server/db.js';
import { sql } from 'drizzle-orm';
import { it, expect } from 'vitest';
import { testStore } from './helpers.js';
import * as s from '../server/schema.js';
import { report } from '../server/reports.js';
async function seed() {
  const store = await testStore();
  await run(
    store.db.insert(s.stations).values([
      {
        id: 'down',
        name: 'sales',
        baseUrl: 'https://example.com',
        kind: 'self',
        authType: 'admin_key',
        role: 'sales',
        costMode: 'token',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'up',
        name: 'cost',
        baseUrl: 'https://example.com',
        kind: 'third_party',
        authType: 'user_jwt',
        role: 'cost',
        costMode: 'subscription',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
    ]),
  );
  await run(
    store.db.insert(s.relations).values({ id: 'rel', downstreamId: 'down', upstreamId: 'up' }),
  );
  const record = {
    model: 'test',
    input: 100,
    output: 50,
    cacheRead: 20,
    cacheCreation: 10,
    currency: 'USD',
    occurredAt: '2026-01-01T12:00:00.000Z',
  };
  await run(
    store.db.insert(s.usage).values([
      { ...record, id: 'd', stationId: 'down', externalId: '1', actualCost: '10' },
      { ...record, id: 'u', stationId: 'up', externalId: '1', actualCost: '99' },
    ]),
  );
  await run(
    store.db.insert(s.correlations).values({
      id: 'link',
      downstreamUsageId: 'd',
      upstreamUsageId: 'u',
      method: 'manual',
      createdAt: '2026-01-01T12:00:00.000Z',
    }),
  );
  return store;
}
it('订阅采购不重复计入 Token 扣费；选中下游仍包含关联固定成本', async () => {
  const store = await seed();
  await run(
    store.db.insert(s.subscriptions).values({
      id: 'sub',
      stationId: 'up',
      name: 'Fixed',
      amount: '30',
      otherFees: '0',
      currency: 'USD',
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-31T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
    }),
  );
  for (const id of [undefined, 'down']) {
    const r = await report(
      store,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      'UTC',
      id,
    );
    expect(r.summary.requests).toBe(1);
    expect(r.finances[0].consumption).toBe('0.00000000');
    expect(r.finances[0].amortization).toBe('1.00000000');
    expect(r.finances[0].profit).toBe('9.00000000');
    expect(r.models[0].grossProfit).toBeNull();
    expect(r.subscriptions[0].net).toBe('9.00000000');
  }
  await store.close();
});
it('缺少固定费用依据时保持待核算', async () => {
  const store = await seed();
  const r = await report(store, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'UTC');
  expect(r.summary.pending).toBe(1);
  expect(r.finances[0].profit).toBeNull();
  await store.close();
});
it('缺失 Token 和账单不变成虚假零，失败率不从成功日志推断', async () => {
  const store = await seed();
  await run(store.db.update(s.usage).set({ input: null, actualCost: null }));
  const r = await report(store, '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z', 'UTC');
  expect(r.summary.input).toBeNull();
  expect(r.summary.totalTokens).toBeNull();
  expect(r.summary.consumption).toBeNull();
  expect(r.summary.successRate).toBeNull();
  await store.close();
});
it('第三方未配置上下游关系时也不叠加主站用量，独立查看第三方仍返回真实用量及采购成本', async () => {
  const store = await seed();
  try {
    await run(store.db.delete(s.correlations));
    await run(store.db.delete(s.relations));
    await run(store.db.update(s.stations).set({ costMode: 'token' }));
    const global = await report(
      store,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      'UTC',
    );
    expect(global.summary.requests).toBe(1);
    expect(global.summary.totalTokens).toBe(180);
    expect(global.summary.unlinked).toBe(1);
    expect(global.summary.pending).toBe(1);
    const third = await report(
      store,
      '2026-01-01T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      'UTC',
      'up',
    );
    expect(third.summary.requests).toBe(1);
    expect(third.finances[0].cost).toBe('99.00000000');
    expect(third.finances[0].revenue).toBe('0.00000000');
  } finally {
    await store.close();
  }
});
