import 'dotenv/config';
import { z } from 'zod';
const env = z.object({
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().default(3001),
  SECONDARY_PORT: z.coerce.number().default(3002),
  ADMIN_USERNAME: z.string().default('admin'),
  ADMIN_PASSWORD: z.string().min(8),
  ENCRYPTION_KEY: z.string().regex(/^[0-9a-f]{64}$/i),
  SESSION_SECRET: z.string().min(32),
  DATABASE_URL: z
    .string()
    .url()
    .refine((x) => x.startsWith('mysql://'), '仅支持 MySQL'),
  REDIS_URL: z
    .string()
    .url()
    .refine((x) => /^rediss?:\/\//.test(x), '需要 Redis 连接地址'),
  REDIS_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9_-]+$/)
    .default('relay'),
  PROCESS_ROLE: z.enum(['api', 'worker', 'all']).default('all'),
  CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(300).default(10),
  APP_TIMEZONE: z.string().default('Asia/Shanghai'),
  SYNC_INTERVAL_SECONDS: z.coerce.number().min(60).default(300),
  COOKIE_SECURE: z.string().default('false'),
  ALLOW_PRIVATE_HOSTS: z.string().default(''),
  FX_PROVIDER: z.enum(['none', 'open_er']).default('none'),
});
export function loadConfig() {
  const c = env.parse(process.env);
  new Intl.DateTimeFormat('en', { timeZone: c.APP_TIMEZONE });
  return c;
}
export type Config = ReturnType<typeof loadConfig>;
