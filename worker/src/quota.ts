import { DurableObject } from "cloudflare:workers";

/** Any authenticated request; one dictation is /extract + /tasks. */
export const PER_MINUTE = 10;
/** Whisper + LLM calls per rolling 24 h. Worst case ~285 neurons each (5-min audio): 30 stays under the 10k free tier. */
export const EXTRACTS_PER_DAY = 30;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

export type QuotaKind = "extract" | "other";
export type QuotaResult = { ok: true } | { ok: false; retryAfterSeconds: number };

/**
 * Strict per-credential quota. Workers Rate Limiting is approximate and per location (it never
 * tripped in testing), and a leaked APP_TOKEN must not be able to burn the account's AI allowance.
 * One instance per credential; every check is synchronous SQL, so concurrent requests can't race.
 */
export class Quota extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS hits (at INTEGER NOT NULL, kind TEXT NOT NULL)");
    });
  }

  /** Records the request if it is within quota. `now` is injectable for tests. */
  consume(kind: QuotaKind, now: number = Date.now()): QuotaResult {
    const sql = this.ctx.storage.sql;
    sql.exec("DELETE FROM hits WHERE at <= ?", now - DAY_MS);

    const minute = sql.exec<{ n: number; oldest: number | null }>(
      "SELECT COUNT(*) AS n, MIN(at) AS oldest FROM hits WHERE at > ?",
      now - MINUTE_MS,
    ).one();
    if (minute.n >= PER_MINUTE) return { ok: false, retryAfterSeconds: Math.ceil((minute.oldest! + MINUTE_MS - now) / 1000) };

    if (kind === "extract") {
      const day = sql.exec<{ n: number; oldest: number | null }>(
        "SELECT COUNT(*) AS n, MIN(at) AS oldest FROM hits WHERE kind = 'extract'",
      ).one();
      if (day.n >= EXTRACTS_PER_DAY) return { ok: false, retryAfterSeconds: Math.ceil((day.oldest! + DAY_MS - now) / 1000) };
    }

    sql.exec("INSERT INTO hits (at, kind) VALUES (?, ?)", now, kind);
    return { ok: true };
  }
}
