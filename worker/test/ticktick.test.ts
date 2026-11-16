import { describe, expect, it } from "vitest";
import { createTask, TickTickAuthError } from "../src/ticktick";

function stubFetch(response: Response) {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return response;
  };
  return { calls, fetcher };
}

describe("createTask", () => {
  it("posts an Inbox task with TickTick dates in the watch's zone", async () => {
    const { calls, fetcher } = stubFetch(Response.json({ id: "abc" }));
    const id = await createTask("tok", { title: "Call bank", due: "2026-11-17T10:00", priority: 5, notes: "card charge" }, "Asia/Kolkata", fetcher);
    expect(id).toBe("abc");
    expect(calls[0]!.url).toBe("https://api.ticktick.com/open/v1/task");
    expect(calls[0]!.body).toEqual({
      title: "Call bank",
      priority: 5,
      timeZone: "Asia/Kolkata",
      content: "card charge",
      startDate: "2026-11-17T10:00:00+0530",
      dueDate: "2026-11-17T10:00:00+0530",
      isAllDay: false,
    });
  });

  it("omits dates for undated tasks", async () => {
    const { calls, fetcher } = stubFetch(Response.json({ id: "x" }));
    await createTask("tok", { title: "Buy milk", priority: 0 }, "Asia/Kolkata", fetcher);
    expect(calls[0]!.body).toEqual({ title: "Buy milk", priority: 0, timeZone: "Asia/Kolkata" });
  });

  it("maps 401 to TickTickAuthError so the watch can ask for re-auth", async () => {
    const { fetcher } = stubFetch(new Response(null, { status: 401 }));
    await expect(createTask("expired", { title: "x", priority: 0 }, "UTC", fetcher)).rejects.toBeInstanceOf(TickTickAuthError);
  });
});
