const DISPLAY_DATE_PATTERN = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/u;
const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/u;
const ISO_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/u;

function calendarDateKey(year: number, month: number, day: number): string | null {
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (year < 1900 || year > 9999 || daysInMonth === undefined || day < 1 || day > daysInMonth) return null;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

export function parseStrictIsoDateKey(text: string): string | null {
  const dateMatch = ISO_DATE_PATTERN.exec(text);
  if (dateMatch) return calendarDateKey(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]));

  const dateTimeMatch = ISO_DATE_TIME_PATTERN.exec(text);
  if (!dateTimeMatch) return null;
  const sourceDate = calendarDateKey(Number(dateTimeMatch[1]), Number(dateTimeMatch[2]), Number(dateTimeMatch[3]));
  const hour = Number(dateTimeMatch[4]);
  const minute = Number(dateTimeMatch[5]);
  const second = Number(dateTimeMatch[6]);
  const zone = dateTimeMatch[8];
  const offsetHour = zone === "Z" ? 0 : Number(zone.slice(1, 3));
  const offsetMinute = zone === "Z" ? 0 : Number(zone.slice(4, 6));
  if (!sourceDate || hour > 23 || minute > 59 || second > 59 || offsetHour > 23 || offsetMinute > 59) return null;
  const instant = new Date(text);
  if (Number.isNaN(instant.getTime())) return null;
  return calendarDateKey(instant.getUTCFullYear(), instant.getUTCMonth() + 1, instant.getUTCDate());
}

export function parseStrictEdsDateKey(text: string): string | null {
  const displayMatch = DISPLAY_DATE_PATTERN.exec(text);
  if (displayMatch) return calendarDateKey(Number(displayMatch[1]), Number(displayMatch[3]), Number(displayMatch[4]));
  return parseStrictIsoDateKey(text);
}
