// Wall-clock math in the watch's IANA time zone, using Intl only.
// "Local" values are wall-clock times without an offset: "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM".

const DAY_MS = 86_400_000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const LOCAL_DUE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}))?$/;

export interface LocalDue {
  year: number;
  month: number;
  day: number;
  /** Absent for all-day dates. */
  time?: { hour: number; minute: number };
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Parses "YYYY-MM-DD" or "YYYY-MM-DDTHH:MM"; null for anything else, including impossible dates. */
export function parseLocalDue(value: string): LocalDue | null {
  const m = LOCAL_DUE.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  if (m[4] === undefined) return { year, month, day };
  const [hour, minute] = [Number(m[4]), Number(m[5])];
  if (hour > 23 || minute > 59) return null;
  return { year, month, day, time: { hour, minute } };
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function wallClock(instant: number, tz: string): WallClock {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { year: get("year"), month: get("month"), day: get("day"), hour: get("hour"), minute: get("minute"), second: get("second") };
}

/** Offset of `tz` from UTC at `instant`, in minutes (Asia/Kolkata → 330). */
function offsetMinutes(instant: number, tz: string): number {
  const w = wallClock(instant, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/** UTC offset in effect at the given wall-clock time in `tz` (handles DST transitions). */
function offsetAtWallClock(due: LocalDue, tz: string): number {
  const guess = Date.UTC(due.year, due.month - 1, due.day, due.time?.hour ?? 0, due.time?.minute ?? 0);
  const first = offsetMinutes(guess - offsetMinutes(guess, tz) * 60_000, tz);
  return offsetMinutes(guess - first * 60_000, tz);
}

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${pad(Math.floor(abs / 60))}${pad(abs % 60)}`;
}

/**
 * Converts a local due value to TickTick's `yyyy-MM-dd'T'HH:mm:ssZ`.
 * All-day dates use local midnight, which is how TickTick stores them.
 */
export function toTickTickDate(due: LocalDue, tz: string): { date: string; isAllDay: boolean } {
  const hour = due.time?.hour ?? 0;
  const minute = due.time?.minute ?? 0;
  const date = `${due.year}-${pad(due.month)}-${pad(due.day)}T${pad(hour)}:${pad(minute)}:00${formatOffset(offsetAtWallClock(due, tz))}`;
  return { date, isAllDay: due.time === undefined };
}

function formatLocal(w: Pick<WallClock, "year" | "month" | "day">): string {
  return `${w.year}-${pad(w.month)}-${pad(w.day)}`;
}

export interface PromptClock {
  /** "Mon 2026-11-16 22:29" */
  now: string;
  /** "Mon 2026-11-16 (today)", "Tue 2026-11-17 (tomorrow)", "Wed 2026-11-18", ... */
  calendar: string[];
  /** Local "YYYY-MM-DDTHH:MM" one, two and three hours from now. */
  inHours: [string, string, string];
}

/** Everything the extraction prompt needs to resolve relative dates without the model doing arithmetic. */
export function promptClock(instant: number, tz: string, days = 21): PromptClock {
  const now = wallClock(instant, tz);
  const today = Date.UTC(now.year, now.month - 1, now.day);
  const calendar: string[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(today + i * DAY_MS);
    const ymd = { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    const tag = i === 0 ? " (today)" : i === 1 ? " (tomorrow)" : "";
    calendar.push(`${WEEKDAYS[d.getUTCDay()]} ${formatLocal(ymd)}${tag}`);
  }
  const later = (hours: number) => {
    const w = wallClock(instant + hours * 3_600_000, tz);
    return `${formatLocal(w)}T${pad(w.hour)}:${pad(w.minute)}`;
  };
  return {
    now: `${WEEKDAYS[new Date(today).getUTCDay()]} ${formatLocal(now)} ${pad(now.hour)}:${pad(now.minute)}`,
    calendar,
    inHours: [later(1), later(2), later(3)],
  };
}
