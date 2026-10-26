import { defineConfig } from 'drizzle-kit';
export default defineConfig({
  dialect: 'mysql',
  schema: './server/schema.ts',
  out: './migrations/mysql',
});
