import { Redis } from 'ioredis';
import { Queue, Worker, UnrecoverableError } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Config } from './config.js';
import type { Store } from './db.js';
import type { RemoteGet } from './adapter.js';
import { Collector } from './sync.js';
import { stations, syncJobs } from './schema.js';
import { syncExchange } from './exchange.js';

export async function openRuntime(config: Config, store: Store, remote?: RemoteGet) {
  const url = new URL(config.REDIS_URL),
    prefix = config.REDIS_PREFIX;
  const connection = {
    host: url.hostname,
    port: Number(url.port || 6379),
    username: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
    db: Number(url.pathname.slice(1) || 0),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    connectTimeout: 5000,
  };
  const redis = new Redis(config.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    connectTimeout: 5000,
  });
  redis.on('error', () => {});
  await redis.connect();
  await redis.ping();
  const queue = new Queue('station-sync', {
    prefix,
    connection: { ...connection, maxRetriesPerRequest: 1 },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: { count: 500, age: 7 * 86400 },
    },
  });
  queue.on('error', () => {});
  await queue.waitUntilReady();
  const collector = new Collector(store, config, remote);
  let worker: Worker | undefined,
    closing = false;
  const workerId = randomUUID();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const invalidate = async () => {
    await redis.incr(`${prefix}:cache:revision`);
  };

  async function enqueue(stationId: string, manual = true) {
    if (closing) throw Object.assign(new Error('后台队列正在关闭'), { statusCode: 503 });
    const id = `sync-${stationId}`;
    try {
      const existing = await queue.getJob(id);
      if (existing) {
        const state = await existing.getState();
        if (['waiting', 'active', 'delayed', 'waiting-children', 'prioritized'].includes(state))
          return { jobId: id, deduplicated: true };
        await existing.remove();
      }
      if (manual) {
        const accepted = await redis.set(`${prefix}:cooldown:${stationId}`, '1', 'PX', 30000, 'NX');
        if (!accepted)
          throw Object.assign(new Error('同一站点至少间隔 30 秒提交同步'), { statusCode: 429 });
      }
      await queue.add('station', { stationId }, { jobId: id });
      return { jobId: id, deduplicated: false };
    } catch (error) {
      if ((error as any).statusCode) throw error;
      throw Object.assign(new Error('Redis 同步队列暂不可用，请稍后重试'), { statusCode: 503 });
    }
  }

  async function startWorkers() {
    if (worker) return;
    worker = new Worker(
      'station-sync',
      async (job) => {
        if (job.name === 'scan') {
          for (const station of await store.db.select().from(stations))
            await enqueue(station.id, false);
          if (config.FX_PROVIDER === 'open_er')
            await queue.add('exchange', {}, { jobId: 'daily-exchange' });
          return { scheduled: true };
        }
        if (job.name === 'exchange') {
          const result = await syncExchange(store, config.FX_PROVIDER);
          await invalidate();
          return result;
        }
        const stationId = String(job.data.stationId);
        if (
          !(
            await store.db
              .select({ id: stations.id })
              .from(stations)
              .where(eq(stations.id, stationId))
          ).length
        )
          return { deleted: true };
        await store.db
          .update(syncJobs)
          .set({
            status: 'interrupted',
            finishedAt: new Date().toISOString(),
            message: 'Redis 已重新取得任务锁，本次执行将从已提交检查点恢复',
          })
          .where(and(eq(syncJobs.queueJobId, String(job.id)), eq(syncJobs.status, 'running')));
        const result = await collector.start(stationId, true, String(job.id), job.attemptsMade + 1);
        await invalidate();
        if (result.status === 'unauthorized')
          throw new UnrecoverableError('站点凭证已失效，请更新凭证');
        if (['error', 'offline'].includes(result.status))
          throw new Error('站点采集失败，将按队列策略退避重试');
        return result;
      },
      {
        prefix,
        connection: { ...connection, maxRetriesPerRequest: null },
        concurrency: 3,
        limiter: { max: 3, duration: 1000 },
        lockDuration: 30000,
        maxStalledCount: 2,
      },
    );
    worker.on('error', () => {});
    worker.on('failed', (_job) => {
      void invalidate().catch(() => {});
    });
    await worker.waitUntilReady();
    const beat = async () => {
      await redis.zadd(`${prefix}:workers`, Date.now(), workerId);
      await redis.zremrangebyscore(`${prefix}:workers`, 0, Date.now() - 30000);
    };
    await beat();
    heartbeat = setInterval(() => void beat().catch(() => {}), 10000);
    heartbeat.unref();
    // BullMQ stores the schedule and recovers stalled work in Redis across restarts.
    await queue.upsertJobScheduler(
      'station-poll',
      { every: config.SYNC_INTERVAL_SECONDS * 1000 },
      { name: 'scan', data: {} },
    );
    await queue.add('scan', {}, { jobId: `startup-${randomUUID()}` });
  }

  async function cached<T>(
    key: string,
    loader: () => Promise<T>,
  ): Promise<{ data: T; hit: boolean }> {
    let cacheKey: string | undefined;
    try {
      const revision = (await redis.get(`${prefix}:cache:revision`)) ?? '0';
      cacheKey = `${prefix}:cache:${revision}:${createHash('sha256').update(key).digest('hex')}`;
      const value = await redis.get(cacheKey);
      if (value !== null) {
        await redis.incr(`${prefix}:cache:hits`);
        return { data: JSON.parse(value), hit: true };
      }
      await redis.incr(`${prefix}:cache:misses`);
    } catch {
      cacheKey = undefined;
    }
    const data = await loader();
    if (cacheKey)
      await redis
        .set(cacheKey, JSON.stringify(data), 'EX', config.CACHE_TTL_SECONDS)
        .catch(() => {});
    return { data, hit: false };
  }

  async function health() {
    await store.pool.query('SELECT 1');
    await redis.ping();
    return {
      database: 'mysql',
      redis: 'ready',
      queue: 'bullmq',
      worker: (await redis.zcount(`${prefix}:workers`, Date.now() - 30000, '+inf')) > 0,
    };
  }
  async function stats() {
    const counts = await queue.getJobCounts('waiting', 'active', 'delayed', 'failed');
    const [hits, misses] = await redis.mget(`${prefix}:cache:hits`, `${prefix}:cache:misses`);
    return {
      ...counts,
      workers: await redis.zcount(`${prefix}:workers`, Date.now() - 30000, '+inf'),
      cacheHits: Number(hits ?? 0),
      cacheMisses: Number(misses ?? 0),
    };
  }
  async function close() {
    if (closing) return;
    closing = true;
    await worker?.close();
    if (heartbeat) clearInterval(heartbeat);
    await redis.zrem(`${prefix}:workers`, workerId).catch(() => {});
    await collector.stop();
    await queue.close();
    await redis.quit();
  }
  return {
    redis,
    queue,
    collector,
    enqueue,
    startWorkers,
    cached,
    invalidate,
    health,
    stats,
    close,
  };
}
export type Runtime = Awaited<ReturnType<typeof openRuntime>>;
