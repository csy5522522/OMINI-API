import { Redis } from 'ioredis';
import { Queue, QueueEvents, Worker, UnrecoverableError } from 'bullmq';
import { createHash, randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import type { Config } from './config.js';
import type { Store } from './db.js';
import type { RemoteGet } from './adapter.js';
import { Collector } from './sync.js';
import { stations, syncJobs, keyMonitors } from './schema.js';
import { collectKeyMonitor } from './key-monitors.js';
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
      removeOnComplete: { count: 100, age: 300 },
      removeOnFail: { count: 500, age: 7 * 86400 },
    },
  });
  queue.on('error', () => {});
  await queue.waitUntilReady();
  const queueEvents = new QueueEvents('station-sync', {
    prefix,
    connection: { ...connection, maxRetriesPerRequest: null },
  });
  queueEvents.on('error', () => {});
  await queueEvents.waitUntilReady();
  const collector = new Collector(store, config, remote);
  let worker: Worker | undefined,
    closing = false;
  const workerId = randomUUID();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const invalidate = async () => {
    await redis.incr(`${prefix}:cache:revision`);
  };

  async function enqueue(stationId: string, manual = true, monitor = false) {
    if (closing) throw Object.assign(new Error('后台队列正在关闭'), { statusCode: 503 });
    const id = `${monitor ? 'key' : 'sync'}-${stationId}`;
    const guard = `${prefix}:enqueue:${id}`,
      token = randomUUID();
    const cooldown = `${prefix}:cooldown:${monitor ? 'key-' : ''}${stationId}`;
    let acquired = false;
    try {
      // Serialize get/remove/add across API instances; BullMQ's job ID deduplicates execution.
      for (let attempt = 0; attempt < 80; attempt++) {
        if (await redis.set(guard, token, 'PX', 10000, 'NX')) {
          acquired = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!acquired)
        throw Object.assign(new Error('监控正在提交刷新，请稍后重试'), { statusCode: 503 });
      const existing = await queue.getJob(id);
      if (existing) {
        const state = await existing.getState();
        if (['waiting', 'active', 'delayed', 'waiting-children', 'prioritized'].includes(state))
          return { jobId: id, deduplicated: true };
        if (monitor && manual && state === 'completed' && (await redis.exists(cooldown)))
          return { jobId: id, deduplicated: true };
      }
      if (manual) {
        const accepted = await redis.set(cooldown, '1', 'PX', 30000, 'NX');
        if (!accepted)
          throw Object.assign(new Error('同一监控至少间隔 30 秒刷新'), { statusCode: 429 });
      }
      if (existing) await existing.remove();
      await queue.add(
        monitor ? 'key-monitor' : 'station',
        monitor ? { monitorId: stationId } : { stationId },
        { jobId: id },
      );
      return { jobId: id, deduplicated: false };
    } catch (error) {
      if ((error as any).statusCode) throw error;
      throw Object.assign(new Error('Redis 同步队列暂不可用，请稍后重试'), { statusCode: 503 });
    } finally {
      if (acquired)
        await redis
          .eval(
            "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
            1,
            guard,
            token,
          )
          .catch(() => {});
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
          for (const monitor of await store.db
            .select({ id: keyMonitors.id })
            .from(keyMonitors)
            .where(eq(keyMonitors.enabled, true)))
            await enqueue(monitor.id, false, true);
          if (config.FX_PROVIDER === 'open_er')
            await queue.add('exchange', {}, { jobId: 'daily-exchange' });
          return { scheduled: true };
        }
        if (job.name === 'exchange') {
          const result = await syncExchange(store, config.FX_PROVIDER);
          await invalidate();
          return result;
        }
        if (job.name === 'key-monitor') {
          const result = await collectKeyMonitor(store, config, String(job.data.monitorId), remote);
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

  async function refresh(stationId: string) {
    const result = await enqueue(stationId);
    const job = await queue.getJob(result.jobId);
    if (!job) throw Object.assign(new Error('刷新任务不可用，请重试'), { statusCode: 422 });
    try {
      return await job.waitUntilFinished(queueEvents, 45000);
    } catch {
      throw Object.assign(new Error('刷新未能完成，请检查站点状态或稍后重试'), { statusCode: 422 });
    }
  }

  const enqueueMonitor = (id: string, manual = true) => enqueue(id, manual, true);
  async function refreshMonitor(id: string) {
    const result = await enqueueMonitor(id);
    const job = await queue.getJob(result.jobId);
    if (!job) throw Object.assign(new Error('刷新任务不可用，请重试'), { statusCode: 422 });
    try {
      await job.waitUntilFinished(queueEvents, 45000);
    } catch {
      throw Object.assign(new Error('检测尚未完成，请稍后查看监控结果'), { statusCode: 422 });
    }
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
    await queueEvents.close();
    await queue.close();
    await redis.quit();
  }
  return {
    redis,
    queue,
    collector,
    enqueue,
    refresh,
    enqueueMonitor,
    refreshMonitor,
    startWorkers,
    cached,
    invalidate,
    health,
    stats,
    close,
  };
}
export type Runtime = Awaited<ReturnType<typeof openRuntime>>;
