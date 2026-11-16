import { describe, expect, it } from "vitest";
import { isSilence } from "../src/extract";
import { CreateTasksBody, tasksFromModel } from "../src/tasks";

describe("tasksFromModel grounding guard", () => {
  it("keeps due and priority only when the speaker's words were quoted", () => {
    const tasks = tasksFromModel({
      tasks: [
        { title: "Call bank", when_said: "tomorrow at ten", due: "2026-11-17T10:00", priority_said: "urgent", priority: 5 },
        { title: "Water plants", due: "2026-11-16", priority: 3 },
        { title: "Pay bill", when_said: "", due: "2026-11-19", priority_said: "", priority: 1 },
      ],
    });
    expect(tasks).toEqual([
      { title: "Call bank", due: "2026-11-17T10:00", priority: 5 },
      { title: "Water plants", priority: 0 },
      { title: "Pay bill", priority: 0 },
    ]);
  });

  it("drops a bad date or unknown priority but keeps the task", () => {
    const tasks = tasksFromModel({
      tasks: [{ title: "  Renew passport ", when_said: "next Friday", due: "next Friday", priority_said: "very", priority: 2, notes: " " }],
    });
    expect(tasks).toEqual([{ title: "Renew passport", priority: 0 }]);
  });

  it("drops items without a usable title and tolerates malformed output", () => {
    expect(tasksFromModel({ tasks: [{ title: "  " }, { due: "2026-11-17" }, "Buy milk", { title: "Buy milk", notes: "2%" }] })).toEqual([
      { title: "Buy milk", priority: 0, notes: "2%" },
    ]);
    expect(tasksFromModel({ tasks: "none" })).toEqual([]);
    expect(tasksFromModel(null)).toEqual([]);
  });
});

describe("CreateTasksBody", () => {
  const ok = { tz: "Asia/Kolkata", tasks: [{ title: "Buy milk", priority: 0 }] };

  it("accepts a valid body", () => {
    expect(CreateTasksBody.safeParse(ok).success).toBe(true);
  });

  it.each([
    ["no tasks", { ...ok, tasks: [] }],
    ["bad due", { ...ok, tasks: [{ title: "x", due: "tomorrow", priority: 0 }] }],
    ["bad priority", { ...ok, tasks: [{ title: "x", priority: 2 }] }],
    ["empty title", { ...ok, tasks: [{ title: " ", priority: 0 }] }],
    ["21 tasks", { ...ok, tasks: Array.from({ length: 21 }, () => ({ title: "x", priority: 0 })) }],
  ])("rejects %s", (_, body) => {
    expect(CreateTasksBody.safeParse(body).success).toBe(false);
  });
});

describe("isSilence", () => {
  it.each([["Thank you."], [" you "], [""], ["Thanks for watching!"]])("treats %j as silence", (t) => {
    expect(isSilence(t)).toBe(true);
  });

  it("keeps real speech that ends with Whisper's 'Thank you.'", () => {
    expect(isSilence("Buy milk. Thank you.")).toBe(false);
  });
});
