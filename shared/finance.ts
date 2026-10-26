import { Decimal } from 'decimal.js';
Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });
export { Decimal };
export const dimensions = ['input', 'output', 'cacheRead', 'cacheCreation'] as const;
export type Tokens = Record<(typeof dimensions)[number], number>;
export type Rates = Record<(typeof dimensions)[number], string>;
export function tokenCharge(tokens: Tokens, rates: Rates, multiplier = '1') {
  return dimensions
    .reduce((sum, k) => sum.plus(new Decimal(tokens[k]).times(rates[k])), new Decimal(0))
    .div(1_000_000)
    .times(multiplier);
}
export function calculate(
  tokens: Tokens,
  buy: Rates,
  sell: Rates,
  multiplier = '1',
  fx = '1',
  other = '0',
) {
  const cost = tokenCharge(tokens, buy, multiplier).times(fx).plus(other);
  const revenue = tokenCharge(tokens, sell, multiplier).times(fx);
  const profit = revenue.minus(cost),
    total = dimensions.reduce((s, k) => s + tokens[k], 0);
  return {
    cost: cost.toFixed(8),
    revenue: revenue.toFixed(8),
    profit: profit.toFixed(8),
    margin: revenue.isZero() ? null : profit.div(revenue).times(100).toFixed(4),
    markup: cost.isZero() ? null : profit.div(cost).times(100).toFixed(4),
    profitPerMillion: total ? profit.div(total).times(1e6).toFixed(8) : null,
    totalTokens: total,
  };
}
export function amortize(
  amount: string,
  other: string,
  start: string,
  end: string,
  from: string,
  to: string,
) {
  const s = Date.parse(start),
    e = Date.parse(end),
    a = Math.max(s, Date.parse(from)),
    b = Math.min(e, Date.parse(to));
  if (e <= s) throw new Error('订阅结束时间必须晚于开始时间');
  return new Decimal(amount)
    .plus(other)
    .times(Math.max(0, b - a))
    .div(e - s)
    .toFixed(8);
}
export function prepaidBalance(recharges: string[], consumption: string[]) {
  return recharges
    .reduce((s, v) => s.plus(v), new Decimal(0))
    .minus(consumption.reduce((s, v) => s.plus(v), new Decimal(0)))
    .toFixed(8);
}
