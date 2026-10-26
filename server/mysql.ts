import { createPool, type PoolConnection } from 'mysql2/promise';
import { drizzle } from 'drizzle-orm/mysql2';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import * as schema from './schema.js';

export async function openDatabase(url: string) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'mysql:') throw new Error('DATABASE_URL 必须是 MySQL 连接地址');
  const pool = createPool({
    host: parsed.hostname,
    port: Number(parsed.port || 3306),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
    database: decodeURIComponent(parsed.pathname.slice(1)),
    connectionLimit: 10,
    waitForConnections: true,
    charset: 'utf8mb4_bin',
    decimalNumbers: false,
    supportBigNumbers: true,
    bigNumberStrings: true,
    flags: ['-FOUND_ROWS'],
    timezone: 'Z',
    connectTimeout: 10000,
  });
  try {
    const connection = await pool.getConnection();
    try {
      await migrate(connection, parsed.pathname.slice(1));
    } finally {
      connection.release();
    }
    return { db: drizzle(pool, { schema, mode: 'default' }), pool, close: () => pool.end() };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

async function migrate(connection: PoolConnection, database: string) {
  const lock = 'relay-migrate-' + createHash('sha256').update(database).digest('hex').slice(0, 32);
  const [locked] = await connection.query<any[]>('SELECT GET_LOCK(?, 30) AS acquired', [lock]);
  if (Number(locked[0]?.acquired) !== 1) throw new Error('未取得数据库迁移锁');
  try {
    await connection.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name VARCHAR(255) PRIMARY KEY, checksum CHAR(64) NOT NULL, applied_at VARCHAR(32) NOT NULL) ENGINE=InnoDB',
    );
    for (const file of readdirSync(resolve('migrations/mysql'))
      .filter((x) => /^\d+_.+\.sql$/.test(x))
      .sort()) {
      const source = readFileSync(resolve('migrations/mysql', file), 'utf8'),
        checksum = createHash('sha256').update(source).digest('hex');
      const [rows] = await connection.query<any[]>(
        'SELECT checksum FROM schema_migrations WHERE name=?',
        [file],
      );
      if (rows.length) {
        if (rows[0].checksum !== checksum) throw new Error(`已应用迁移校验失败：${file}`);
        continue;
      }
      for (const statement of source
        .split('--> statement-breakpoint')
        .map((x) => x.trim())
        .filter(Boolean))
        await connection.query(statement);
      await connection.query(
        'INSERT INTO schema_migrations(name,checksum,applied_at) VALUES(?,?,?)',
        [file, checksum, new Date().toISOString()],
      );
    }
  } finally {
    await connection.query('SELECT RELEASE_LOCK(?)', [lock]);
  }
}

export async function one<T>(query: PromiseLike<T[]>): Promise<T | undefined> {
  return (await query)[0];
}
export async function run(query: PromiseLike<any>): Promise<{ changes: number }> {
  const [result] = await query;
  return { changes: result.affectedRows ?? 0 };
}
export type Store = Awaited<ReturnType<typeof openDatabase>>;
