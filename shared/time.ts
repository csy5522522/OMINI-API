export function dayIn(date: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  return ['year', 'month', 'day'].map((k) => parts.find((p) => p.type === k)!.value).join('-');
}
export function dayStart(day: string, tz: string) {
  let d = new Date(`${day}T00:00:00Z`);
  for (let i = 0; i < 3; i++) {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(d);
    const n = (k: string) => p.find((x) => x.type === k)!.value;
    const shown = Date.parse(
      `${n('year')}-${n('month')}-${n('day')}T${n('hour')}:${n('minute')}:${n('second')}Z`,
    );
    d = new Date(d.getTime() + Date.parse(`${day}T00:00:00Z`) - shown);
  }
  return d.toISOString();
}
export function addDay(day: string, n: number) {
  return new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10);
}
export function periodRange(period: string, tz: string, from = '', to = '', now = new Date()) {
  const today = dayIn(now, tz);
  let start = today,
    end = addDay(today, 1);
  if (period === 'yesterday') {
    start = addDay(today, -1);
    end = today;
  } else if (period === 'month') start = today.slice(0, 8) + '01';
  else if (period === 'custom' && from && to) {
    start = from;
    end = addDay(to, 1);
  } else if (period !== 'today') start = addDay(today, -((Number(period) || 7) - 1));
  return { from: dayStart(start, tz), to: dayStart(end, tz) };
}
