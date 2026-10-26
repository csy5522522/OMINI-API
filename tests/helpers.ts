import { openDatabase, type Store } from '../server/db.js';
import { loadConfig, type Config } from '../server/config.js';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { getTableName } from 'drizzle-orm';
import * as schema from '../server/schema.js';

export function testConfig(overrides: Partial<Config> = {}): Config {
  const production = loadConfig(),
    database = process.env.TEST_DATABASE_URL,
    redis = process.env.TEST_REDIS_URL;
  if (
    !database ||
    database === production.DATABASE_URL ||
    !new URL(database).pathname.endsWith('_test')
  )
    throw new Error('测试需要独立且以 _test 结尾的 TEST_DATABASE_URL，禁止清理正式数据库');
  if (!redis || redis === production.REDIS_URL) throw new Error('测试需要独立 TEST_REDIS_URL');
  return {
    ...production,
    DATABASE_URL: database,
    REDIS_URL: redis,
    REDIS_PREFIX: 'test-' + randomBytes(6).toString('hex'),
    PROCESS_ROLE: 'api',
    HOST: '127.0.0.1',
    PORT: 0,
    SECONDARY_PORT: 0,
    CACHE_TTL_SECONDS: 1,
    ADMIN_USERNAME: 'admin',
    ADMIN_PASSWORD: 'test-password-long',
    ENCRYPTION_KEY: 'ab'.repeat(32),
    SESSION_SECRET: 'test-session-secret'.repeat(4),
    ALLOW_PRIVATE_HOSTS: '127.0.0.1',
    ...overrides,
  };
}
export async function testStore(): Promise<Store> {
  const store = await openDatabase(testConfig().DATABASE_URL),
    connection = await store.pool.getConnection();
  try {
    await connection.query('SET FOREIGN_KEY_CHECKS=0');
    for (const table of Object.values(schema)) {
      const name = getTableName(table);
      await connection.query(`TRUNCATE TABLE \`${name}\``);
    }
  } finally {
    await connection.query('SET FOREIGN_KEY_CHECKS=1');
    connection.release();
  }
  return store;
}
export async function clearTestRedis(config: Config) {
  if (!config.REDIS_PREFIX.startsWith('test-')) throw new Error('禁止清理非测试 Redis 前缀');
  const redis = new Redis(config.REDIS_URL);
  try {
    let cursor = '0';
    do {
      const result = await redis.scan(cursor, 'MATCH', `${config.REDIS_PREFIX}:*`, 'COUNT', 100);
      cursor = result[0];
      if (result[1].length) await redis.del(...result[1]);
    } while (cursor !== '0');
  } finally {
    await redis.quit();
  }
}
export async function until(condition: () => Promise<boolean>, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('等待后台任务超时');
}
