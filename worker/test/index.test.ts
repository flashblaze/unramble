import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";

const AUTH = { Authorization: "Bearer test-app-token" };

async function call(path: string, init: RequestInit = {}) {
  const res = await exports.default.fetch(`https://unramble.test${path}`, { method: "POST", ...init });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("auth", () => {
  it.each([
    ["missing", {}],
    ["wrong", { Authorization: "Bearer nope" }],
    ["not bearer", { Authorization: "test-app-token" }],
  ])("rejects %s token before revealing routes", async (_, headers) => {
    expect(await call("/extract?tz=UTC", { headers })).toEqual({ status: 401, body: { error: "unauthorized" } });
    expect(await call("/anything", { headers })).toEqual({ status: 401, body: { error: "unauthorized" } });
  });
});

describe("/extract input checks", () => {
  it("rejects an unknown time zone", async () => {
    expect(await call("/extract?tz=Mars/Base", { headers: AUTH, body: new Uint8Array([1]) })).toEqual({ status: 400, body: { error: "bad_timezone" } });
  });

  it("rejects empty and oversized audio", async () => {
    expect(await call("/extract?tz=UTC", { headers: AUTH, body: new Uint8Array() })).toEqual({ status: 400, body: { error: "empty_audio" } });
    const big = new Uint8Array(1.5 * 1024 * 1024 + 1);
    expect(await call("/extract?tz=UTC", { headers: AUTH, body: big })).toEqual({ status: 413, body: { error: "too_large" } });
  });
});

describe("/tasks input checks", () => {
  it("rejects invalid bodies without calling TickTick", async () => {
    expect(await call("/tasks", { headers: AUTH, body: "not json" })).toEqual({ status: 400, body: { error: "bad_request" } });
    expect(await call("/tasks", { headers: AUTH, body: JSON.stringify({ tz: "UTC", tasks: [] }) })).toEqual({ status: 400, body: { error: "bad_request" } });
    expect(
      await call("/tasks", { headers: AUTH, body: JSON.stringify({ tz: "Nope/Zone", tasks: [{ title: "x", priority: 0 }] }) }),
    ).toEqual({ status: 400, body: { error: "bad_timezone" } });
  });
});

describe("/tasks partial failure", () => {
  afterEach(() => vi.restoreAllMocks());

  // Regression: failures were matched by title on the watch, so a retry re-created a same-titled task.
  it("reports failed tasks by position so retries never duplicate same-titled tasks", async () => {
    let n = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      ++n === 2 ? new Response("upstream error", { status: 500 }) : Response.json({ id: `id${n}` }),
    );
    const tasks = [
      { title: "Call mom", priority: 0 },
      { title: "Call mom", due: "2026-11-20", priority: 0 },
    ];
    expect(await call("/tasks", { headers: AUTH, body: JSON.stringify({ tz: "UTC", tasks }) })).toEqual({
      status: 200,
      body: { created: [{ title: "Call mom", id: "id1" }], failed: [{ index: 1, title: "Call mom", error: "ticktick_failed" }] },
    });
  });
});
