import { describe, expect, it } from "vitest";
import { parseLocalDue, promptClock, toTickTickDate } from "../src/dates";

const tickTick = (due: string, tz: string) => toTickTickDate(parseLocalDue(due)!, tz);

describe("toTickTickDate", () => {
  it("timed due keeps the wall-clock time with the zone's offset", () => {
    expect(tickTick("2026-11-17T10:00", "Asia/Kolkata")).toEqual({ date: "2026-11-17T10:00:00+0530", isAllDay: false });
    expect(tickTick("2026-11-17T10:00", "Asia/Kathmandu")).toEqual({ date: "2026-11-17T10:00:00+0545", isAllDay: false });
  });

  it("all-day due is local midnight", () => {
    expect(tickTick("2026-11-17", "Asia/Kolkata")).toEqual({ date: "2026-11-17T00:00:00+0530", isAllDay: true });
  });

  it("uses the offset in effect on the due date, not today", () => {
    expect(tickTick("2026-07-01T09:00", "America/New_York").date).toBe("2026-07-01T09:00:00-0400");
    expect(tickTick("2026-12-01T09:00", "America/New_York").date).toBe("2026-12-01T09:00:00-0500");
  });
});

describe("parseLocalDue", () => {
  it.each(["2026-02-30", "2026-11-17T24:00", "2026-11-17T10:60", "tomorrow", "2026-11-17T10:00:00", ""])("rejects %j", (v) => {
    expect(parseLocalDue(v)).toBeNull();
  });
});

describe("promptClock", () => {
  // 2026-11-16 16:59 UTC = Mon 22:29 in Kolkata, Mon 08:59 in Los Angeles.
  const instant = Date.UTC(2026, 10, 16, 16, 59);

  it("labels days in the watch's zone and crosses midnight for 'in N hours'", () => {
    const clock = promptClock(instant, "Asia/Kolkata");
    expect(clock.now).toBe("Mon 2026-11-16 22:29");
    expect(clock.calendar.slice(0, 4)).toEqual(["Mon 2026-11-16 (today)", "Tue 2026-11-17 (tomorrow)", "Wed 2026-11-18", "Thu 2026-11-19"]);
    expect(clock.calendar).toHaveLength(21);
    expect(clock.inHours).toEqual(["2026-11-16T23:29", "2026-11-17T00:29", "2026-11-17T01:29"]);
  });

  it("same instant, different zone, different 'today'", () => {
    expect(promptClock(Date.UTC(2026, 10, 16, 20, 0), "Asia/Kolkata").calendar[0]).toBe("Tue 2026-11-17 (today)");
    expect(promptClock(Date.UTC(2026, 10, 16, 20, 0), "America/Los_Angeles").calendar[0]).toBe("Mon 2026-11-16 (today)");
  });
});
