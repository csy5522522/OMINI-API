import { it, expect } from 'vitest';
import { testStore, testConfig, clearTestRedis, until } from './helpers.js';
import { openRuntime } from '../server/runtime.js';
import { run } from '../server/db.js';
import { encrypt } from '../server/security.js';
import * as s from '../server/schema.js';
import { mockSub2Api } from './mock-sub2api.js';

it('真实 Redis 队列跨实例持久化、去重、Worker 采集并写入真实 MySQL', async () => {
  const store = await testStore(),
    config = testConfig(),
    remote = await mockSub2Api();
  let runtime = await openRuntime(config, store);
  try {
    await run(
      store.db.insert(s.stations).values({
        id: 'queue-station',
        name: 'Integration station',
        baseUrl: remote.url,
        kind: 'self',
        authType: 'admin_key',
        role: 'sales',
        createdAt: new Date().toISOString(),
      }),
    );
    await run(
      store.db.insert(s.credentials).values({
        stationId: 'queue-station',
        encrypted: encrypt('admin-secret', config.ENCRYPTION_KEY),
        masked: 'masked',
      }),
    );
    const first = await runtime.enqueue('queue-station'),
      second = await runtime.enqueue('queue-station');
    expect(second.jobId).toBe(first.jobId);
    expect(second.deduplicated).toBe(true);
    expect((await runtime.queue.getJob(first.jobId))?.data).toEqual({ stationId: 'queue-station' });
    await runtime.close();
    runtime = await openRuntime(config, store);
    await runtime.startWorkers();
    await until(async () =>
      Boolean((await store.db.select().from(s.syncJobs)).find((x) => x.status === 'completed')),
    );
    expect(await store.db.select().from(s.usage)).toHaveLength(1);
    const jobs = await store.db.select().from(s.syncJobs);
    expect(jobs[0].queueJobId).toBe('sync-queue-station');
    expect(jobs[0].attempt).toBe(1);
    expect(remote.calls.length).toBeGreaterThan(0);
  } finally {
    await runtime.close();
    await clearTestRedis(config);
    await remote.app.close();
    await store.close();
  }
});

it('真实 Redis 缓存命中、版本失效与 TTL 到期不返回过时财务报表', async () => {
  const store = await testStore(),
    config = testConfig(),
    runtime = await openRuntime(config, store);
  let calls = 0;
  const load = async () => ({ value: ++calls });
  try {
    expect(await runtime.cached('report', load)).toEqual({ data: { value: 1 }, hit: false });
    expect(await runtime.cached('report', load)).toEqual({ data: { value: 1 }, hit: true });
    await runtime.invalidate();
    expect((await runtime.cached('report', load)).data.value).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 1150));
    expect((await runtime.cached('report', load)).data.value).toBe(3);
    expect((await runtime.stats()).cacheHits).toBeGreaterThan(0);
  } finally {
    await runtime.close();
    await clearTestRedis(config);
    await store.close();
  }
});
