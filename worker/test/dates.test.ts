import { describe, expect, it } from "vitest";
import { alignWeekday, parseLocalDue, promptClock, toTickTickDate } from "../src/dates";

describe("alignWeekday", () => {
  // Tue 17 Nov 2026, 08:47 in Kolkata: the morning the bug showed up in history.
  const now = Date.UTC(2026, 10, 17, 3, 17);
  const tz = "Asia/Kolkata";

  it("moves a due date that contradicts the named weekday to that weekday, keeping the time", () => {
    // Regression: gpt-oss returned Saturday 21 Nov for "by Thursday evening" in 2 of 3 runs.
    expect(alignWeekday("2026-11-21T18:00", "by Thursday evening", now, tz)).toBe("2026-11-19T18:00");
    expect(alignWeekday("2026-11-24", "next Friday", now, tz)).toBe("2026-11-20");
  });

  it("leaves correct dates alone", () => {
    expect(alignWeekday("2026-11-19T18:00", "by Thursday evening", now, tz)).toBe("2026-11-19T18:00");
    expect(alignWeekday("2026-11-26", "Thursday", now, tz)).toBe("2026-11-26"); // a later Thursday is still a Thursday
  });

  it("trusts the model for arithmetic, explicit dates, several weekdays, or no weekday", () => {
    expect(alignWeekday("2026-11-18", "before Thursday", now, tz)).toBe("2026-11-18");
    expect(alignWeekday("2026-11-26", "a week before the 3rd of December", now, tz)).toBe("2026-11-26");
    expect(alignWeekday("2026-11-27", "a week after Friday", now, tz)).toBe("2026-11-27");
    expect(alignWeekday("2026-11-23", "Monday or Tuesday", now, tz)).toBe("2026-11-23");
    expect(alignWeekday("2026-11-18T10:00", "tomorrow around ten", now, tz)).toBe("2026-11-18T10:00");
  });

  it("counts from today in the watch's zone and never picks today itself", () => {
    // Thu 19 Nov 23:00 in Kolkata is still Thursday there: "Thursday" means next week's.
    const thursdayNight = Date.UTC(2026, 10, 19, 17, 30);
    expect(alignWeekday("2026-11-21", "Thursday", thursdayNight, tz)).toBe("2026-11-26");
  });
});

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
