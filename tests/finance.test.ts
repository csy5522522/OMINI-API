import { describe, it, expect } from 'vitest';
import { calculate, amortize, prepaidBalance, tokenCharge } from '../shared/finance.js';
const tokens = { input: 1_000_000, output: 500_000, cacheRead: 2_000_000, cacheCreation: 100_000 };
const buy = { input: '2', output: '8', cacheRead: '0.2', cacheCreation: '2.5' },
  sell = { input: '3', output: '12', cacheRead: '0.3', cacheCreation: '3.75' };
describe('精确财务计算', () => {
  it('分别计费输入、输出、读缓存和写缓存', () => {
    expect(tokenCharge(tokens, buy).toString()).toBe('6.65');
  });
  it('倍率、历史汇率与额外费用', () => {
    const r = calculate(tokens, buy, sell, '0.75', '7.2', '1');
    expect(r.cost).toBe('36.91000000');
    expect(r.revenue).toBe('53.86500000');
    expect(r.profit).toBe('16.95500000');
    expect(r.margin).not.toBe(r.markup);
  });
  it('十进制不产生浮点误差', () => {
    expect(
      calculate(
        { input: 1_000_000, output: 0, cacheRead: 0, cacheCreation: 0 },
        { ...buy, input: '0.1' },
        { ...sell, input: '0.3' },
        '3',
      ).profit,
    ).toBe('0.60000000');
  });
  it('零收入、零成本不产生 Infinity 或 NaN', () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      r = calculate(zero, buy, sell);
    expect(r.margin).toBeNull();
    expect(r.markup).toBeNull();
    expect(r.profitPerMillion).toBeNull();
  });
  it('订阅按真实有效期摊销、裁剪查询边界', () => {
    expect(
      amortize(
        '300',
        '10',
        '2026-01-01T00:00:00Z',
        '2026-02-01T00:00:00Z',
        '2025-12-01T00:00:00Z',
        '2026-01-11T00:00:00Z',
      ),
    ).toBe('100.00000000');
    expect(
      amortize(
        '300',
        '0',
        '2026-01-01T00:00:00Z',
        '2026-02-01T00:00:00Z',
        '2026-03-01T00:00:00Z',
        '2026-04-01T00:00:00Z',
      ),
    ).toBe('0.00000000');
  });
  it('充值是预付款，只有实际消耗扣减余额', () => {
    expect(prepaidBalance(['100', '20.5'], ['10.2', '0.3'])).toBe('110.00000000');
  });
  it('无效订阅期间拒绝计算', () => {
    expect(() =>
      amortize('10', '0', '2026-02-01', '2026-01-01', '2026-01-01', '2026-02-01'),
    ).toThrow();
  });
});
