import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import mysql from 'mysql2/promise';
process.on('uncaughtException', (error) => {
  console.error('Local provisioning failed:', error.code ?? error.name);
  process.exit(1);
});
mkdirSync('data', { recursive: true });
const adminPath = 'data/mysql-admin.json';
const saved = existsSync(adminPath) ? JSON.parse(readFileSync(adminPath, 'utf8')) : null;
const connection = await mysql.createConnection({
  host: '127.0.0.1',
  port: 3307,
  user: 'root',
  password: saved?.rootPassword ?? '',
});
const rootPassword = saved?.rootPassword ?? randomBytes(32).toString('hex');
const appPassword = saved?.appPassword ?? randomBytes(32).toString('hex');
const redisPassword = saved?.redisPassword ?? randomBytes(32).toString('hex');
await connection.query(
  'CREATE DATABASE IF NOT EXISTS observatory CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
);
await connection.query(
  'CREATE DATABASE IF NOT EXISTS observatory_test CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
);
for (const host of ['localhost', '127.0.0.1']) {
  await connection.query('CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?', [
    'observatory',
    host,
    appPassword,
  ]);
  await connection.query('GRANT ALL PRIVILEGES ON observatory.* TO ?@?', ['observatory', host]);
  await connection.query('GRANT ALL PRIVILEGES ON observatory_test.* TO ?@?', [
    'observatory',
    host,
  ]);
}
if (!saved) await connection.query("ALTER USER 'root'@'localhost' IDENTIFIED BY ?", [rootPassword]);
writeFileSync(adminPath, JSON.stringify({ rootPassword, appPassword, redisPassword }), {
  mode: 0o600,
});
let env = readFileSync('.env', 'utf8');
for (const [key, value] of Object.entries({
  DATABASE_URL: `mysql://observatory:${appPassword}@127.0.0.1:3307/observatory`,
  TEST_DATABASE_URL: `mysql://observatory:${appPassword}@127.0.0.1:3307/observatory_test`,
  REDIS_URL: `redis://:${redisPassword}@127.0.0.1:6380/0`,
  TEST_REDIS_URL: `redis://:${redisPassword}@127.0.0.1:6380/1`,
  REDIS_PREFIX: 'relay',
  MYSQL_PASSWORD: appPassword,
  MYSQL_ROOT_PASSWORD: rootPassword,
  REDIS_PASSWORD: redisPassword,
  PROCESS_ROLE: 'all',
  PORT: '3001',
  SECONDARY_PORT: '3002',
})) {
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  env = pattern.test(env) ? env.replace(pattern, `${key}=${value}`) : env + `\n${key}=${value}\n`;
}
env = env.replace(/^DATABASE_PATH=.*\r?\n?/m, '').replace(/^DEMO_HOST=.*\r?\n?/m, '');
writeFileSync('.env', env, { mode: 0o600 });
mkdirSync('data/redis', { recursive: true });
const redisDir =
  process
    .cwd()
    .replaceAll('\\', '/')
    .replace(/^([A-Za-z]):/, (_match, drive) => `/mnt/${drive.toLowerCase()}`) + '/data/redis';
writeFileSync(
  'data/redis/redis.conf',
  `bind 127.0.0.1\nprotected-mode yes\nport 6380\nrequirepass ${redisPassword}\ndaemonize yes\ndir "${redisDir}"\nappendonly yes\nappendfsync everysec\nmaxmemory-policy noeviction\nlogfile "${redisDir}/redis.log"\npidfile "${redisDir}/redis.pid"\n`,
);
await connection.end();
console.log(
  'Dedicated MySQL databases/users provisioned; private connection settings saved to .env.',
);
