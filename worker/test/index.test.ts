import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const AUTH = { Authorization: "Bearer test-app-token" };

async function call(path: string, init: RequestInit = {}) {
  const res = await exports.default.fetch(`https://voice-tasks.test${path}`, { method: "POST", ...init });
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
    const big = new Uint8Array(3 * 1024 * 1024 + 1);
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
