// Dictation history (PLAN.md, Phase 2b): audio → R2 directly, records → Queue → D1.
// Everything here runs off the watch's critical path (ctx.waitUntil or the queue consumer).
import { z } from "zod";
import { errorSummary } from "./errors";
import { Task } from "./tasks";

const RETRY_DELAY_SECONDS = 30;

const DictationMessage = z.object({
  type: z.literal("dictation"),
  id: z.uuid(),
  createdAt: z.number().int(),
  tz: z.string(),
  outcome: z.enum(["extracted", "no_speech", "failed"]),
  /** Error type (name) when failed; never a message, which could quote the dictation. */
  error: z.string().optional(),
  transcript: z.string().optional(),
  tasks: z.array(Task).optional(),
  model: z.string().optional(),
  audioKey: z.string().optional(),
  audioBytes: z.number().int(),
  audioError: z.string().optional(),
  whisperMs: z.number().int().optional(),
  llmMs: z.number().int().optional(),
});
export type DictationMessage = z.infer<typeof DictationMessage>;

const SubmissionMessage = z.object({
  type: z.literal("submission"),
  /** One per /tasks call, so a redelivered message inserts nothing. */
  id: z.uuid(),
  dictationId: z.uuid(),
  createdAt: z.number().int(),
  submitted: z.array(Task),
  createdCount: z.number().int(),
  failedCount: z.number().int(),
});
export type SubmissionMessage = z.infer<typeof SubmissionMessage>;

export const HistoryMessage = z.discriminatedUnion("type", [DictationMessage, SubmissionMessage]);
export type HistoryMessage = z.infer<typeof HistoryMessage>;

export type AudioResult = { audioKey: string } | { audioError: string };

/**
 * Stores the recording at audio/YYYY/MM/DD/<id>.ogg (UTC date), retrying with backoff. Never throws:
 * a failure is reported in the result so the dictation row still gets written.
 */
export async function saveAudio(bucket: R2Bucket, id: string, at: number, tz: string, audio: Uint8Array, attempts = 3): Promise<AudioResult> {
  const key = `audio/${new Date(at).toISOString().slice(0, 10).replaceAll("-", "/")}/${id}.ogg`;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await bucket.put(key, audio, { httpMetadata: { contentType: "audio/ogg" }, customMetadata: { tz } });
      return { audioKey: key };
    } catch (error) {
      lastError = error;
      if (attempt < attempts - 1) await scheduler.wait(300 * 2 ** attempt);
    }
  }
  return { audioError: errorSummary(lastError) };
}

/**
 * Sends one history message for the background (pass to ctx.waitUntil). Accepts a promise so the
 * dictation message can wait for the audio upload without blocking the response. Never rejects.
 */
export async function sendHistory(queue: Queue, message: HistoryMessage | Promise<HistoryMessage>): Promise<void> {
  try {
    await queue.send(await message, { contentType: "json" });
  } catch (error) {
    console.error(JSON.stringify({ message: "history enqueue failed", error: errorSummary(error) }));
  }
}

function insertStatement(db: D1Database, message: HistoryMessage): D1PreparedStatement {
  if (message.type === "dictation") {
    return db
      .prepare(
        `INSERT INTO dictations (id, created_at, tz, outcome, error, transcript, extracted_json, model,
                                 audio_key, audio_bytes, audio_error, whisper_ms, llm_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
      )
      .bind(
        message.id,
        message.createdAt,
        message.tz,
        message.outcome,
        message.error ?? null,
        message.transcript ?? null,
        message.tasks ? JSON.stringify(message.tasks) : null,
        message.model ?? null,
        message.audioKey ?? null,
        message.audioBytes,
        message.audioError ?? null,
        message.whisperMs ?? null,
        message.llmMs ?? null,
      );
  }
  return db
    .prepare(
      `INSERT INTO submissions (id, dictation_id, created_at, submitted_json, created_count, failed_count)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    )
    .bind(message.id, message.dictationId, message.createdAt, JSON.stringify(message.submitted), message.createdCount, message.failedCount);
}

/**
 * Queue consumer. Valid messages are written in one D1 batch (all-or-nothing) and acked; a D1 error
 * retries them with a delay (→ DLQ after max_retries). Invalid messages are acked and logged:
 * retrying can't fix them.
 */
export async function consumeHistory(batch: MessageBatch<unknown>, db: D1Database): Promise<void> {
  const valid: { message: Message<unknown>; body: HistoryMessage }[] = [];
  for (const message of batch.messages) {
    const parsed = HistoryMessage.safeParse(message.body);
    if (parsed.success) {
      valid.push({ message, body: parsed.data });
    } else {
      console.error(JSON.stringify({ message: "history message invalid", messageId: message.id }));
      message.ack();
    }
  }
  if (valid.length === 0) return;
  try {
    await db.batch(valid.map(({ body }) => insertStatement(db, body)));
    for (const { message } of valid) message.ack();
  } catch (error) {
    console.error(JSON.stringify({ message: "history write failed", count: valid.length, error: errorSummary(error) }));
    for (const { message } of valid) message.retry({ delaySeconds: RETRY_DELAY_SECONDS });
  }
}

/** Deletes dictations and submissions created before `cutoff` (unix ms), plus their audio. */
export async function purgeHistory(db: D1Database, bucket: R2Bucket, cutoff: number): Promise<{ dictations: number; audio: number }> {
  const { results } = await db
    .prepare("SELECT audio_key FROM dictations WHERE created_at < ? AND audio_key IS NOT NULL")
    .bind(cutoff)
    .all<{ audio_key: string }>();
  const keys = results.map((row) => row.audio_key);
  // R2 deletes up to 1000 keys per call; missing keys (already expired by the lifecycle rule) are fine.
  for (let i = 0; i < keys.length; i += 1000) await bucket.delete(keys.slice(i, i + 1000));
  // RETURNING counts dictations only (meta.changes would include the search-index trigger writes).
  const [, deleted] = await db.batch<{ id: string }>([
    db.prepare("DELETE FROM submissions WHERE created_at < ?").bind(cutoff),
    db.prepare("DELETE FROM dictations WHERE created_at < ? RETURNING id").bind(cutoff),
  ]);
  return { dictations: deleted!.results.length, audio: keys.length };
}
