// 使用服务返回的工作区当地日期；UTC 仅用于日期运算，不把浏览器时区混入周历。
export function calendarDate(value: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('工作区日期无效');
  const date = new Date(value + 'T12:00:00Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new Error('工作区日期无效');
  return date;
}
export function weekStart(localDate: string, offset = 0): Date {
  if (!Number.isSafeInteger(offset)) throw new Error('周历偏移无效');
  const date = calendarDate(localDate);
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7 + offset * 7);
  return date;
}
export function localInputTime(instant: number, timezone: string): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(instant).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function defaultScheduleTime(localDate: string, timezone: string, selectedDate?: string, now = Date.now()): string {
  calendarDate(selectedDate ?? localDate);
  if (selectedDate) return selectedDate + 'T20:00';
  const current = localInputTime(now, timezone);
  // 当天20点已过时给一个未来建议；用户仍须明确保存，服务再次验证时间。
  return current < localDate + 'T20:00' ? localDate + 'T20:00' : localInputTime(now + 60 * 60_000, timezone);
}
