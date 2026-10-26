import { Redis } from 'ioredis';
import { loadConfig } from './config.js';
const config = loadConfig(),
  redis = new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, connectTimeout: 3000 });
redis.on('error', () => {});
try {
  const count = await redis.zcount(`${config.REDIS_PREFIX}:workers`, Date.now() - 30000, '+inf');
  await redis.quit();
  process.exit(count > 0 ? 0 : 1);
} catch {
  redis.disconnect();
  process.exit(1);
}
