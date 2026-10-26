import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createApp } from './app.js';
import { openRuntime } from './runtime.js';
import type { FastifyInstance } from 'fastify';
const config = loadConfig(),
  store = await openDatabase(config.DATABASE_URL);
const runtime = await openRuntime(config, store);
const apps: FastifyInstance[] = [];
if (config.PROCESS_ROLE !== 'api') await runtime.startWorkers();
if (config.PROCESS_ROLE !== 'worker') {
  for (const port of [...new Set([config.PORT, config.SECONDARY_PORT])].filter((x) => x > 0)) {
    const { app } = await createApp(config, store, { logger: true, runtime });
    await app.listen({ host: config.HOST, port });
    apps.push(app);
  }
} else console.log('Redis worker is ready; durable scheduler is active.');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    void (async () => {
      await Promise.all(apps.map((x) => x.close()));
      await runtime.close();
      await store.close();
      process.exit(0);
    })();
  });
