import {
  mysqlTable,
  varchar,
  text,
  json,
  int,
  tinyint,
  bigint,
  boolean,
  decimal,
  uniqueIndex,
  index,
  check,
} from 'drizzle-orm/mysql-core';
import { sql } from 'drizzle-orm';
export const stations = mysqlTable(
  'stations',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    baseUrl: varchar('base_url', { length: 512 }).notNull(),
    kind: varchar('kind', { length: 32 }).notNull(),
    mainSlot: tinyint('main_slot').generatedAlwaysAs(
      sql`CASE WHEN kind = 'self' THEN 1 ELSE NULL END`,
      { mode: 'stored' },
    ),
    authType: varchar('auth_type', { length: 32 }).notNull(),
    role: varchar('role', { length: 32 }).notNull(),
    costMode: varchar('cost_mode', { length: 32 }).notNull().default('token'),
    currency: varchar('currency', { length: 3 }).notNull().default('USD'),
    notes: varchar('notes', { length: 2000 }).notNull().default(''),
    status: varchar('status', { length: 32 }).notNull().default('pending'),
    version: varchar('version', { length: 255 }),
    lastSync: varchar('last_sync', { length: 32 }),
    latency: int('latency'),
    checkpoint: varchar('checkpoint', { length: 32 }),
    snapshot: json('snapshot').$type<Record<string, any>>(),
    createdAt: varchar('created_at', { length: 32 }).notNull(),
  },
  (t) => [
    uniqueIndex('station_single_main').on(t.mainSlot),
    check(
      'station_kind_role',
      sql`(${t.kind} = 'self' AND ${t.role} = 'sales') OR (${t.kind} = 'third_party' AND ${t.role} = 'cost')`,
    ),
    check(
      'station_kind_auth',
      sql`(${t.kind} = 'self' AND ${t.authType} IN ('admin_key','admin_jwt')) OR (${t.kind} = 'third_party' AND ${t.authType} IN ('user_jwt','api_key'))`,
    ),
  ],
);
export const credentials = mysqlTable('station_credentials', {
  stationId: varchar('station_id', { length: 64 })
    .primaryKey()
    .references(() => stations.id, { onDelete: 'cascade' }),
  encrypted: text('encrypted').notNull(),
  masked: varchar('masked', { length: 255 }).notNull(),
});
export const capabilities = mysqlTable(
  'station_capabilities',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    stationId: varchar('station_id', { length: 64 })
      .notNull()
      .references(() => stations.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    status: varchar('status', { length: 32 }).notNull(),
    httpStatus: int('http_status'),
    message: text('message').notNull(),
    checkedAt: varchar('checked_at', { length: 32 }).notNull(),
  },
  (t) => [uniqueIndex('cap_station_name').on(t.stationId, t.name)],
);
export const models = mysqlTable(
  'models',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    stationId: varchar('station_id', { length: 64 })
      .notNull()
      .references(() => stations.id, { onDelete: 'cascade' }),
    model: varchar('model', { length: 255 }).notNull(),
    source: varchar('source', { length: 255 }).notNull(),
    observedAt: varchar('observed_at', { length: 32 }).notNull(),
  },
  (t) => [uniqueIndex('model_station').on(t.stationId, t.model)],
);
export const pricing = mysqlTable(
  'model_pricing',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    stationId: varchar('station_id', { length: 64 })
      .notNull()
      .references(() => stations.id, { onDelete: 'cascade' }),
    model: varchar('model', { length: 255 }).notNull(),
    currency: varchar('currency', { length: 3 }).notNull(),
    buy: json('buy').$type<Record<string, string>>().notNull(),
    sell: json('sell').$type<Record<string, string>>().notNull(),
    multiplier: decimal('multiplier', { precision: 30, scale: 12 }).notNull(),
    effectiveAt: varchar('effective_at', { length: 32 }).notNull(),
    source: varchar('source', { length: 255 }).notNull(),
    createdAt: varchar('created_at', { length: 32 }).notNull(),
  },
  (t) => [index('price_effective').on(t.stationId, t.model, t.effectiveAt)],
);
export const usage = mysqlTable(
  'usage_records',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    stationId: varchar('station_id', { length: 64 })
      .notNull()
      .references(() => stations.id, { onDelete: 'cascade' }),
    externalId: varchar('external_id', { length: 255 }).notNull(),
    requestId: varchar('request_id', { length: 255 }),
    upstreamRequestId: varchar('upstream_request_id', { length: 255 }),
    model: varchar('model', { length: 255 }).notNull(),
    input: bigint('input', { mode: 'number', unsigned: true }),
    output: bigint('output', { mode: 'number', unsigned: true }),
    cacheRead: bigint('cache_read', { mode: 'number', unsigned: true }),
    cacheCreation: bigint('cache_creation', { mode: 'number', unsigned: true }),
    actualCost: decimal('actual_cost', { precision: 30, scale: 12 }),
    currency: varchar('currency', { length: 3 }).notNull(),
    duration: int('duration'),
    firstToken: int('first_token'),
    success: boolean('success'),
    occurredAt: varchar('occurred_at', { length: 32 }).notNull(),
    priceId: varchar('price_id', { length: 64 }).references(() => pricing.id),
    estimatedCost: decimal('estimated_cost', { precision: 30, scale: 12 }),
    estimatedRevenue: decimal('estimated_revenue', { precision: 30, scale: 12 }),
    fxId: varchar('fx_id', { length: 64 }),
    billingMode: varchar('billing_mode', { length: 32 }).notNull().default('token'),
  },
  (t) => [
    uniqueIndex('usage_external').on(t.stationId, t.externalId),
    index('usage_time').on(t.occurredAt, t.stationId),
    index('usage_request').on(t.stationId, t.requestId),
  ],
);
export const aggregates = mysqlTable(
  'usage_aggregates',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    stationId: varchar('station_id', { length: 64 })
      .notNull()
      .references(() => stations.id, { onDelete: 'cascade' }),
    day: varchar('day', { length: 255 }).notNull(),
    data: json('data').$type<Record<string, any>>().notNull(),
    observedAt: varchar('observed_at', { length: 32 }).notNull(),
  },
  (t) => [uniqueIndex('agg_station_day').on(t.stationId, t.day)],
);
export const subscriptions = mysqlTable('subscriptions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  stationId: varchar('station_id', { length: 64 })
    .notNull()
    .references(() => stations.id),
  name: varchar('name', { length: 255 }).notNull(),
  amount: decimal('amount', { precision: 30, scale: 12 }).notNull(),
  otherFees: decimal('other_fees', { precision: 30, scale: 12 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  start: varchar('start', { length: 32 }).notNull(),
  end: varchar('end', { length: 32 }).notNull(),
  quota: decimal('quota', { precision: 30, scale: 12 }),
  used: decimal('used', { precision: 30, scale: 12 }),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
});
export const recharges = mysqlTable('recharge_records', {
  id: varchar('id', { length: 64 }).primaryKey(),
  stationId: varchar('station_id', { length: 64 })
    .notNull()
    .references(() => stations.id),
  amount: decimal('amount', { precision: 30, scale: 12 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  occurredAt: varchar('occurred_at', { length: 32 }).notNull(),
  note: text('note').notNull(),
});
export const transactions = mysqlTable('financial_transactions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  stationId: varchar('station_id', { length: 64 })
    .notNull()
    .references(() => stations.id),
  kind: varchar('kind', { length: 32 }).notNull(),
  amount: decimal('amount', { precision: 30, scale: 12 }).notNull(),
  currency: varchar('currency', { length: 3 }).notNull(),
  occurredAt: varchar('occurred_at', { length: 32 }).notNull(),
  note: text('note').notNull(),
  fxId: varchar('fx_id', { length: 64 }),
});
export const fxRates = mysqlTable('exchange_rates', {
  id: varchar('id', { length: 64 }).primaryKey(),
  from: varchar('from_currency', { length: 3 }).notNull(),
  to: varchar('to_currency', { length: 3 }).notNull(),
  rate: decimal('rate', { precision: 30, scale: 12 }).notNull(),
  effectiveAt: varchar('effective_at', { length: 32 }).notNull(),
  source: varchar('source', { length: 255 }).notNull(),
});
export const relations = mysqlTable(
  'station_relations',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    downstreamId: varchar('downstream_id', { length: 64 })
      .notNull()
      .references(() => stations.id),
    upstreamId: varchar('upstream_id', { length: 64 })
      .notNull()
      .references(() => stations.id),
  },
  (t) => [
    uniqueIndex('relation_pair').on(t.downstreamId, t.upstreamId),
    check('station_relation_not_self', sql`${t.downstreamId} <> ${t.upstreamId}`),
  ],
);
export const correlations = mysqlTable(
  'request_correlations',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    downstreamUsageId: varchar('downstream_usage_id', { length: 64 })
      .notNull()
      .references(() => usage.id),
    upstreamUsageId: varchar('upstream_usage_id', { length: 64 })
      .notNull()
      .references(() => usage.id),
    method: varchar('method', { length: 255 }).notNull(),
    createdAt: varchar('created_at', { length: 32 }).notNull(),
  },
  (t) => [
    uniqueIndex('correlation_down').on(t.downstreamUsageId),
    uniqueIndex('correlation_up').on(t.upstreamUsageId),
    check('correlation_not_self', sql`${t.downstreamUsageId} <> ${t.upstreamUsageId}`),
  ],
);
export const alertRules = mysqlTable('alert_rules', {
  id: varchar('id', { length: 64 }).primaryKey(),
  stationId: varchar('station_id', { length: 64 }).references(() => stations.id),
  type: varchar('type', { length: 255 }).notNull(),
  threshold: decimal('threshold', { precision: 30, scale: 12 }).notNull(),
  cooldown: int('cooldown').notNull(),
  enabled: boolean('enabled').notNull(),
});
export const alerts = mysqlTable('alert_events', {
  id: varchar('id', { length: 64 }).primaryKey(),
  ruleId: varchar('rule_id', { length: 64 }).references(() => alertRules.id),
  stationId: varchar('station_id', { length: 64 }).references(() => stations.id),
  type: varchar('type', { length: 255 }).notNull(),
  message: text('message').notNull(),
  status: varchar('status', { length: 32 }).notNull(),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
});
export const syncJobs = mysqlTable('sync_jobs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  stationId: varchar('station_id', { length: 64 })
    .notNull()
    .references(() => stations.id, { onDelete: 'cascade' }),
  status: varchar('status', { length: 32 }).notNull(),
  startedAt: varchar('started_at', { length: 32 }).notNull(),
  finishedAt: varchar('finished_at', { length: 32 }),
  message: text('message'),
  count: int('count').notNull().default(0),
  queueJobId: varchar('queue_job_id', { length: 128 }),
  attempt: int('attempt').notNull().default(0),
});
export const audit = mysqlTable('audit_logs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  action: varchar('action', { length: 255 }).notNull(),
  entityId: varchar('entity_id', { length: 64 }).notNull(),
  details: json('details'),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
});
export const settings = mysqlTable('settings', {
  key: varchar('key', { length: 191 }).primaryKey(),
  value: json('value').$type<any>().notNull(),
});
export const sessions = mysqlTable('sessions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  expiresAt: bigint('expires_at', { mode: 'number', unsigned: true }).notNull(),
});
export const upstreamAccounts = mysqlTable(
  'upstream_accounts',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    stationId: varchar('station_id', { length: 64 })
      .notNull()
      .references(() => stations.id, { onDelete: 'cascade' }),
    externalId: varchar('external_id', { length: 64 }).notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    platform: varchar('platform', { length: 64 }).notNull(),
    type: varchar('type', { length: 64 }).notNull(),
    baseUrl: varchar('base_url', { length: 512 }),
    keyPresent: boolean('key_present'),
    status: varchar('status', { length: 64 }).notNull(),
    schedulable: boolean('schedulable'),
    checkedAt: varchar('checked_at', { length: 32 }),
    checkResult: json('check_result').$type<Record<string, any>>(),
    observedAt: varchar('observed_at', { length: 32 }).notNull(),
  },
  (t) => [uniqueIndex('account_station_external').on(t.stationId, t.externalId)],
);
export const mcpKeys = mysqlTable(
  'mcp_keys',
  {
    id: varchar('id', { length: 64 }).primaryKey(),
    name: varchar('name', { length: 100 }).notNull(),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    prefix: varchar('prefix', { length: 24 }).notNull(),
    createdAt: varchar('created_at', { length: 32 }).notNull(),
    expiresAt: varchar('expires_at', { length: 32 }).notNull(),
    lastUsedAt: varchar('last_used_at', { length: 32 }),
    revokedAt: varchar('revoked_at', { length: 32 }),
  },
  (t) => [uniqueIndex('mcp_key_hash').on(t.tokenHash)],
);
export const keyMonitors = mysqlTable('key_monitors', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 100 }).notNull(),
  baseUrl: varchar('base_url', { length: 512 }).notNull(),
  protocol: varchar('protocol', { length: 32 }).notNull(),
  encrypted: text('encrypted').notNull(),
  masked: varchar('masked', { length: 32 }).notNull(),
  enabled: boolean('enabled').notNull().default(true),
  balanceEnabled: boolean('balance_enabled').notNull().default(false),
  balanceThreshold: decimal('balance_threshold', { precision: 30, scale: 12 })
    .notNull()
    .default('10'),
  currency: varchar('currency', { length: 3 }).notNull().default('USD'),
  revision: int('revision').notNull().default(0),
  result: json('result').$type<Record<string, any>>(),
  checkedAt: varchar('checked_at', { length: 32 }),
  incident: varchar('incident', { length: 64 }),
  alertId: varchar('alert_id', { length: 64 }),
  lastAlertAt: varchar('last_alert_at', { length: 32 }),
  createdAt: varchar('created_at', { length: 32 }).notNull(),
});
