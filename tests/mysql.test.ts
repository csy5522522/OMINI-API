import { it, expect } from 'vitest';
import { testStore, testConfig } from './helpers.js';
import { openDatabase, run } from '../server/db.js';
import * as s from '../server/schema.js';
import { getTableName } from 'drizzle-orm';
it('真实 MySQL 迁移、事务回滚、外键约束和重启幂等', async () => {
  let store = await testStore();
  const [tables] = await store.pool.query<any[]>(
    'SELECT table_name FROM information_schema.tables WHERE table_schema=DATABASE()',
  );
  expect(tables.map((row) => row.TABLE_NAME ?? row.table_name).sort()).toEqual(
    [...Object.values(s).map(getTableName), 'schema_migrations'].sort(),
  );
  await expect(
    run(
      store.db
        .insert(s.credentials)
        .values({ stationId: 'missing', encrypted: 'test', masked: 'masked' }),
    ),
  ).rejects.toThrow();
  await expect(
    store.db.transaction(async (tx) => {
      await run(
        tx.insert(s.stations).values({
          id: 'rollback',
          name: 'test',
          baseUrl: 'https://example.com',
          kind: 'self',
          authType: 'admin_key',
          role: 'sales',
          createdAt: new Date().toISOString(),
        }),
      );
      throw new Error('rollback');
    }),
  ).rejects.toThrow('rollback');
  expect(await store.db.select().from(s.stations)).toHaveLength(0);
  const [before] = await store.pool.query<any[]>('SELECT COUNT(*) AS n FROM schema_migrations');
  await store.close();
  store = await openDatabase(testConfig().DATABASE_URL);
  const [after] = await store.pool.query<any[]>('SELECT COUNT(*) AS n FROM schema_migrations');
  expect(after[0].n).toBe(before[0].n);
  await store.close();
});
it('MySQL 直接并发写入也只能存在一个主中转站，第三方可多个且受角色约束', async () => {
  const store = await testStore();
  try {
    const common = {
      name: 'test',
      baseUrl: 'https://example.com',
      kind: 'self',
      authType: 'admin_key',
      role: 'sales',
      createdAt: new Date().toISOString(),
    };
    const results = await Promise.allSettled(
      ['main-a', 'main-b'].map((id) => run(store.db.insert(s.stations).values({ ...common, id }))),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    for (const id of ['third-a', 'third-b'])
      await run(
        store.db
          .insert(s.stations)
          .values({ ...common, id, kind: 'third_party', authType: 'user_jwt', role: 'cost' }),
      );
    await expect(
      run(
        store.db
          .insert(s.stations)
          .values({ ...common, id: 'third-forged-role', kind: 'third_party', authType: 'api_key' }),
      ),
    ).rejects.toThrow();
    await expect(
      run(
        store.db
          .insert(s.stations)
          .values({ ...common, id: 'third-admin', kind: 'third_party', role: 'cost' }),
      ),
    ).rejects.toThrow();
    expect(await store.db.select().from(s.stations)).toHaveLength(3);
  } finally {
    await store.close();
  }
});
