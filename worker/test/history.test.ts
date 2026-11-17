import { createExecutionContext, createMessageBatch, getQueueResult, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeHistory, purgeHistory, saveAudio, type HistoryMessage } from "../src/history";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;
const AUTH = { Authorization: "Bearer test-app-token" };
const T0 = Date.UTC(2026, 10, 17, 9, 0);
const DAY = 86_400_000;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function dictation(id: string, overrides: Partial<HistoryMessage> = {}): HistoryMessage {
  return {
    type: "dictation",
    id,
    createdAt: T0,
    tz: "Asia/Kolkata",
    outcome: "extracted",
    transcript: "call the plumber tomorrow morning",
    tasks: [{ title: "Call the plumber", due: "2026-11-18T09:00", priority: 0 }],
    model: "@cf/openai/gpt-oss-120b",
    audioKey: `audio/2026/11/17/${id}.ogg`,
    audioBytes: 1000,
    whisperMs: 1,
    llmMs: 2,
    ...overrides,
  } as HistoryMessage;
}

function submission(id: string, dictationId: string): HistoryMessage {
  return {
    type: "submission",
    id,
    dictationId,
    createdAt: T0 + 1000,
    submitted: [{ title: "Call the plumber", priority: 0 }],
    createdCount: 1,
    failedCount: 0,
  };
}

async function consume(bodies: unknown[], db: D1Database = env.DB) {
  const batch = createMessageBatch(
    "unramble-history",
    bodies.map((body, i) => ({ id: `m${i}`, timestamp: new Date(), attempts: 1, body })),
  );
  const ctx = createExecutionContext();
  await consumeHistory(batch, db);
  return getQueueResult(batch, ctx);
}

describe("queue consumer", () => {
  it("writes idempotently and tolerates a submission arriving before its dictation", async () => {
    const result = await consume([submission(uuid(1), uuid(2)), dictation(uuid(2)), dictation(uuid(2))]);
    expect(result.explicitAcks.sort()).toEqual(["m0", "m1", "m2"]);
    expect(result.retryMessages).toEqual([]);
    const rows = await env.DB.prepare(
      "SELECT d.transcript, s.created_count FROM dictations d JOIN submissions s ON s.dictation_id = d.id WHERE d.id = ?",
    )
      .bind(uuid(2))
      .all();
    expect(rows.results).toEqual([{ transcript: "call the plumber tomorrow morning", created_count: 1 }]);
  });

  it("acks invalid messages without blocking valid ones", async () => {
    const result = await consume([{ type: "nope" }, dictation(uuid(3))]);
    expect(result.explicitAcks.sort()).toEqual(["m0", "m1"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM dictations WHERE id = ?").bind(uuid(3)).first("n")).toBe(1);
  });

  it("retries when D1 fails", async () => {
    const failing = { prepare: env.DB.prepare.bind(env.DB), batch: () => Promise.reject(new Error("D1 down")) } as unknown as D1Database;
    const result = await consume([dictation(uuid(4))], failing);
    expect(result.explicitAcks).toEqual([]);
    expect(result.retryMessages).toMatchObject([{ msgId: "m0" }]);
  });

  it("indexes transcripts for full-text search", async () => {
    await consume([dictation(uuid(5)), dictation(uuid(6), { transcript: "buy milk on the way home" })]);
    const hits = await env.DB.prepare(
      "SELECT d.id FROM dictations_fts f JOIN dictations d ON d.rowid = f.rowid WHERE dictations_fts MATCH ?",
    )
      .bind("plumber")
      .all<{ id: string }>();
    // Other tests in this file share the database: only this test's rows matter.
    const ids = hits.results.map((r) => r.id);
    expect(ids).toContain(uuid(5));
    expect(ids).not.toContain(uuid(6));
  });
});

describe("purgeHistory", () => {
  it("deletes old rows, their audio and their search entries, keeping newer ones", async () => {
    const old = dictation(uuid(7), { createdAt: T0 - 100 * DAY, transcript: "ancient errand", audioKey: "audio/old.ogg" });
    const recent = dictation(uuid(8), { audioKey: "audio/new.ogg" });
    await consume([old, recent, { ...submission(uuid(9), uuid(7)), createdAt: T0 - 100 * DAY }]);
    await env.AUDIO.put("audio/old.ogg", "x");
    await env.AUDIO.put("audio/new.ogg", "y");

    expect(await purgeHistory(env.DB, env.AUDIO, T0 - 50 * DAY)).toEqual({ dictations: 1, audio: 1 });
    expect(await env.AUDIO.head("audio/old.ogg")).toBeNull();
    expect(await env.AUDIO.head("audio/new.ogg")).not.toBeNull();
    const left = await env.DB.prepare("SELECT id FROM dictations WHERE id IN (?, ?)").bind(uuid(7), uuid(8)).all<{ id: string }>();
    expect(left.results).toEqual([{ id: uuid(8) }]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM submissions WHERE id = ?").bind(uuid(9)).first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM dictations_fts WHERE dictations_fts MATCH 'ancient'").first("n")).toBe(0);
  });
});

describe("saveAudio", () => {
  it("stores the recording under audio/YYYY/MM/DD/<id>.ogg", async () => {
    const result = await saveAudio(env.AUDIO, uuid(10), T0, "Asia/Kolkata", new Uint8Array([1, 2, 3]));
    expect(result).toEqual({ audioKey: `audio/2026/11/17/${uuid(10)}.ogg` });
    const object = await env.AUDIO.get(`audio/2026/11/17/${uuid(10)}.ogg`);
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(object!.customMetadata).toEqual({ tz: "Asia/Kolkata" });
  });

  it("gives up after 3 attempts and reports the error type instead of throwing", async () => {
    const put = vi.fn().mockRejectedValue(new TypeError("r2 down"));
    const result = await saveAudio({ put } as unknown as R2Bucket, uuid(11), T0, "UTC", new Uint8Array([1]));
    expect(put).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ audioError: "TypeError: r2 down" });
  });
});

describe("main flow isolation", () => {
  afterEach(() => vi.restoreAllMocks());

  const fakeAI = (llm: () => unknown) =>
    ({
      run: async (model: string) => (model.includes("whisper") ? { text: "Buy milk tomorrow." } : llm()),
    }) as unknown as Ai;
  const tasksReply = () => ({
    choices: [{ message: { content: JSON.stringify({ tasks: [{ title: "Buy milk", when_said: "tomorrow", due: "2026-11-18", priority: 0 }] }) } }],
  });
  const capturingQueue = () => {
    const sent: unknown[] = [];
    return { sent, queue: { send: async (body: unknown) => void sent.push(body) } as unknown as Queue };
  };

  async function call(path: string, testEnv: Env, body: BodyInit) {
    const ctx = createExecutionContext();
    const res = await worker.fetch!(new IncomingRequest(`https://unramble.test${path}`, { method: "POST", headers: AUTH, body }), testEnv, ctx);
    await waitOnExecutionContext(ctx);
    return res;
  }

  it("/extract answers normally when R2 and the queue both fail", async () => {
    const broken = { put: () => Promise.reject(new Error("r2 down")) } as unknown as R2Bucket;
    const deadQueue = { send: () => Promise.reject(new Error("queue down")) } as unknown as Queue;
    const res = await call("/extract?tz=UTC", { ...env, AI: fakeAI(tasksReply), AUDIO: broken, HISTORY: deadQueue }, new Uint8Array([1, 2, 3]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { dictationId: string; tasks: unknown[] };
    expect(body.dictationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.tasks).toEqual([{ title: "Buy milk", due: "2026-11-18", priority: 0 }]);
  });

  it("a failed extraction is still recorded, with its audio", async () => {
    const { sent, queue } = capturingQueue();
    const res = await call(
      "/extract?tz=UTC",
      { ...env, AI: fakeAI(() => Promise.reject(new RangeError("model down"))), HISTORY: queue },
      new Uint8Array([9, 9, 9]),
    );
    expect(res.status).toBe(500);
    expect(sent).toHaveLength(1);
    const message = sent[0] as Extract<HistoryMessage, { type: "dictation" }>;
    expect(message).toMatchObject({ type: "dictation", outcome: "failed", error: "RangeError", transcript: "Buy milk tomorrow.", audioBytes: 3 });
    expect(await env.AUDIO.head(message.audioKey!)).not.toBeNull();
  });

  it("/tasks with a dictationId records the submission", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ id: "t1" }));
    const { sent, queue } = capturingQueue();
    const dictationId = uuid(12);
    const res = await call("/tasks", { ...env, HISTORY: queue }, JSON.stringify({ tz: "UTC", dictationId, tasks: [{ title: "Buy milk", priority: 0 }] }));
    expect(res.status).toBe(200);
    expect(sent).toMatchObject([{ type: "submission", dictationId, createdCount: 1, failedCount: 0, submitted: [{ title: "Buy milk", priority: 0 }] }]);
  });
});
