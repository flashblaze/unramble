import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { EXTRACTS_PER_DAY, PER_MINUTE } from "../src/quota";

const T0 = Date.UTC(2026, 10, 17, 12, 0);

describe("Quota", () => {
  it("allows PER_MINUTE requests per minute, then frees up as the window slides", async () => {
    const quota = env.QUOTA.getByName("minute-test");
    for (let i = 0; i < PER_MINUTE; i++) expect(await quota.consume("other", T0 + i * 1000)).toEqual({ ok: true });
    expect(await quota.consume("other", T0 + 30_000)).toEqual({ ok: false, retryAfterSeconds: 30 });
    expect(await quota.consume("other", T0 + 60_001)).toEqual({ ok: true });
  });

  it("caps /extract per rolling day so a leaked token can't drain the AI allowance", async () => {
    const quota = env.QUOTA.getByName("day-test");
    // Spaced out so the per-minute limit never applies.
    for (let i = 0; i < EXTRACTS_PER_DAY; i++) expect(await quota.consume("extract", T0 + i * 120_000)).toEqual({ ok: true });
    const blocked = await quota.consume("extract", T0 + EXTRACTS_PER_DAY * 120_000);
    expect(blocked.ok).toBe(false);
    expect(await quota.consume("other", T0 + EXTRACTS_PER_DAY * 120_000)).toEqual({ ok: true });
    expect(await quota.consume("extract", T0 + 86_400_001)).toEqual({ ok: true });
  });
});
