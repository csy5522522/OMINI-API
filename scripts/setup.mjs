import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) {
  console.log('.env already exists. No files changed.');
  process.exit(0);
}
const password = randomBytes(18).toString('base64url'),
  mysqlPassword = randomBytes(32).toString('hex'),
  rootPassword = randomBytes(32).toString('hex'),
  redisPassword = randomBytes(32).toString('hex');
let env = readFileSync('.env.example', 'utf8');
for (const [key, value] of Object.entries({
  ADMIN_PASSWORD: password,
  ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  SESSION_SECRET: randomBytes(48).toString('hex'),
  MYSQL_PASSWORD: mysqlPassword,
  MYSQL_ROOT_PASSWORD: rootPassword,
  REDIS_PASSWORD: redisPassword,
  DATABASE_URL: `mysql://observatory:${mysqlPassword}@127.0.0.1:3306/observatory`,
  REDIS_URL: `redis://:${redisPassword}@127.0.0.1:6379/0`,
}))
  env = env.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
writeFileSync('.env', env, { mode: 0o600 });
console.log(
  'Created .env with independent MySQL, Redis and application secrets. Read ADMIN_PASSWORD from .env to sign in.',
);
