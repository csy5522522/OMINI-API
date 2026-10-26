import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
const store = await openDatabase(loadConfig().DATABASE_URL);
const [rows] = await store.pool.query(
  'SELECT name,applied_at FROM schema_migrations ORDER BY name',
);
console.log('MySQL initialized:', rows);
await store.close();
