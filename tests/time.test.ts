import { it, expect } from 'vitest';
import { periodRange, dayStart } from '../shared/time.js';
it('今日覆盖完整当前日，最近 7 天恰为七个自然日，避免遗漏当日 Key 聚合', () => {
  const now = new Date('2026-10-25T18:00:00Z');
  const today = periodRange('today', 'Asia/Shanghai', '', '', now);
  expect(today).toEqual({ from: '2026-10-25T16:00:00.000Z', to: '2026-10-26T16:00:00.000Z' });
  const week = periodRange('7', 'Asia/Shanghai', '', '', now);
  expect((Date.parse(week.to) - Date.parse(week.from)) / 864e5).toBe(7);
  expect(periodRange('yesterday', 'Asia/Shanghai', '', '', now).to).toBe(today.from);
  expect(periodRange('dayAfterTomorrow', 'Asia/Shanghai', '', '', now)).toEqual({
    from: '2026-10-27T16:00:00.000Z',
    to: '2026-10-28T16:00:00.000Z',
  });
  const threeDays = periodRange('3', 'Asia/Shanghai', '', '', now);
  expect((Date.parse(threeDays.to) - Date.parse(threeDays.from)) / 864e5).toBe(3);
  expect(threeDays.to).toBe(today.to);
});
it('时区日边界支持夏令时，并使自定义结束日期含当天', () => {
  expect(dayStart('2026-03-08', 'America/New_York')).toBe('2026-03-08T05:00:00.000Z');
  expect(dayStart('2026-03-09', 'America/New_York')).toBe('2026-03-09T04:00:00.000Z');
  expect(periodRange('custom', 'UTC', '2026-01-01', '2026-01-02').to).toBe(
    '2026-01-03T00:00:00.000Z',
  );
});
