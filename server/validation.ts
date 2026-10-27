import { z } from 'zod';
export const money = z.string().regex(/^\d{1,16}(\.\d{1,12})?$/, '金额必须是非负十进制字符串');
export const currency = z.enum(['USD', 'CNY', 'EUR', 'AED']);
export const date = z
  .string()
  .datetime({ offset: true })
  .transform((x) => new Date(x).toISOString());
export const rates = z.object({
  input: money,
  output: money,
  cacheRead: money,
  cacheCreation: money,
});
export const stationBody = z
  .object({
    name: z.string().min(1).max(80),
    baseUrl: z
      .string()
      .url()
      .max(500)
      .transform((x) => x.replace(/\/$/, '')),
    kind: z.enum(['self', 'third_party']),
    authType: z.enum(['admin_key', 'admin_jwt', 'user_jwt', 'api_key']),
    role: z.enum(['sales', 'cost', 'observe']).optional(),
    costMode: z.enum(['token', 'subscription', 'prepaid']).default('token'),
    currency: currency.default('USD'),
    notes: z.string().max(2000).default(''),
    credential: z.string().min(1).max(8192),
    balanceThreshold: money.optional(),
  })
  .superRefine((x, c) => {
    if (x.kind === 'self' && !['admin_key', 'admin_jwt'].includes(x.authType))
      c.addIssue({ code: 'custom', message: '主中转站必须使用自己的管理员密钥或管理员 JWT' });
    if (x.kind === 'third_party' && ['admin_key', 'admin_jwt'].includes(x.authType))
      c.addIssue({ code: 'custom', message: '第三方站点请使用普通用户 JWT 或模型 API Key' });
    if (x.balanceThreshold !== undefined && x.kind !== 'third_party')
      c.addIssue({ code: 'custom', message: '余额监控请使用第三方站点' });
  })
  .transform(({ role: _legacyRole, ...x }) => ({
    ...x,
    role: x.kind === 'self' ? ('sales' as const) : ('cost' as const),
  }));
export const priceBody = z.object({
  stationId: z.string(),
  model: z.string().min(1).max(200),
  currency,
  buy: rates,
  sell: rates,
  multiplier: money,
  effectiveAt: date,
});
export const subscriptionBody = z
  .object({
    stationId: z.string(),
    name: z.string().min(1).max(100),
    amount: money,
    otherFees: money.default('0'),
    currency,
    start: date,
    end: date,
    quota: money.nullable().default(null),
    used: money.nullable().default(null),
  })
  .refine((x) => x.end > x.start, { message: '订阅结束时间必须晚于开始时间' });
export const transactionBody = z.object({
  stationId: z.string(),
  kind: z.enum(['revenue', 'consumption', 'other']),
  amount: money,
  currency,
  occurredAt: date,
  note: z.string().min(1).max(500),
});
