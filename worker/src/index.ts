import { errorSummary } from "./errors";
import { extractTasks, isSilence, transcribe } from "./extract";
import { isValidTimeZone } from "./dates";
import { consumeHistory, purgeHistory, saveAudio, sendHistory, type DictationMessage } from "./history";
import { CreateTasksBody } from "./tasks";
import { loadVocabulary, whisperPrompt } from "./vocabulary";
import { createTask, TickTickAuthError } from "./ticktick";

/** The app records ≤ 5 min of 24 kbps Opus (~900 KB); headroom for VBR, but far below abuse-sized uploads. */
const MAX_AUDIO_BYTES = 1.5 * 1024 * 1024;
const MAX_JSON_BYTES = 64 * 1024;

type ErrorCode =
  | "unauthorized"
  | "not_found"
  | "method_not_allowed"
  | "rate_limited"
  | "bad_timezone"
  | "bad_request"
  | "empty_audio"
  | "too_large"
  | "no_speech"
  | "ticktick_auth_expired"
  | "internal";

function errorResponse(status: number, error: ErrorCode): Response {
  return Response.json({ error }, { status });
}

async function isAuthorized(request: Request, expected: string | undefined): Promise<boolean> {
  const header = request.headers.get("Authorization") ?? "";
  if (!expected || !header.startsWith("Bearer ")) return false;
  const encoder = new TextEncoder();
  const [provided, wanted] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(header.slice("Bearer ".length))),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(provided, wanted);
}

/** Reads the body up to `limit` bytes; null if it is larger. Rejects early on a too-large Content-Length. */
async function readBody(request: Request, limit: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get("Content-Length") ?? 0) > limit) return null;
  if (!request.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request.body) {
    size += chunk.byteLength;
    if (size > limit) return null;
    chunks.push(chunk);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** POST /extract?tz=<IANA zone>, body = Ogg/Opus audio. → {dictationId, transcript, tasks} */
async function handleExtract(request: Request, env: Env, ctx: ExecutionContext, url: URL, requestId: string): Promise<Response> {
  const tz = url.searchParams.get("tz") ?? "";
  if (!isValidTimeZone(tz)) return errorResponse(400, "bad_timezone");
  const audio = await readBody(request, MAX_AUDIO_BYTES);
  if (!audio) return errorResponse(413, "too_large");
  if (audio.byteLength === 0) return errorResponse(400, "empty_audio");

  const dictationId = crypto.randomUUID();
  const startedAt = Date.now();
  // History runs beside the main flow and is never awaited here. The audio upload starts before
  // Whisper so recordings that fail to process are kept too.
  const audioSaved = env.SAVE_HISTORY !== "false" ? saveAudio(env.AUDIO, dictationId, startedAt, tz, audio) : null;
  const entry: DictationMessage = {
    type: "dictation",
    id: dictationId,
    createdAt: startedAt,
    tz,
    outcome: "failed",
    audioBytes: audio.byteLength,
  };
  try {
    const vocabulary = await loadVocabulary(env.DB);
    const whisperStart = Date.now();
    const transcript = await transcribe(env.AI, audio, whisperPrompt(vocabulary));
    entry.transcript = transcript;
    entry.whisperMs = Date.now() - whisperStart;
    if (isSilence(transcript, vocabulary)) {
      entry.outcome = "no_speech";
      console.log(JSON.stringify({ message: "extract", requestId, audioBytes: audio.byteLength, whisperMs: entry.whisperMs, outcome: "no_speech" }));
      return errorResponse(422, "no_speech");
    }

    const llmStart = Date.now();
    const { tasks, model } = await extractTasks(env.AI, transcript, Date.now(), tz, vocabulary);
    Object.assign(entry, { outcome: "extracted", tasks, model, llmMs: Date.now() - llmStart });
    console.log(
      JSON.stringify({
        message: "extract",
        requestId,
        audioBytes: audio.byteLength,
        words: transcript.split(/\s+/).length,
        tasks: tasks.length,
        model,
        whisperMs: entry.whisperMs,
        llmMs: entry.llmMs,
      }),
    );
    return Response.json({ dictationId, transcript, tasks });
  } catch (error) {
    entry.error = error instanceof Error ? error.name : "unknown";
    throw error;
  } finally {
    if (audioSaved) ctx.waitUntil(sendHistory(env.HISTORY, audioSaved.then((saved) => ({ ...entry, ...saved }))));
  }
}

/** POST /tasks, body = {tz, tasks}. Creates each task in the TickTick Inbox. → {created, failed} */
async function handleTasks(request: Request, env: Env, ctx: ExecutionContext, requestId: string): Promise<Response> {
  const raw = await readBody(request, MAX_JSON_BYTES);
  if (!raw) return errorResponse(413, "too_large");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return errorResponse(400, "bad_request");
  }
  const body = CreateTasksBody.safeParse(json);
  if (!body.success) return errorResponse(400, "bad_request");
  const { tz, tasks, dictationId } = body.data;
  if (!isValidTimeZone(tz)) return errorResponse(400, "bad_timezone");

  const recordSubmission = (createdCount: number, failedCount: number) => {
    if (!dictationId || env.SAVE_HISTORY === "false") return;
    ctx.waitUntil(
      sendHistory(env.HISTORY, {
        type: "submission",
        id: crypto.randomUUID(),
        dictationId,
        createdAt: Date.now(),
        submitted: tasks,
        createdCount,
        failedCount,
      }),
    );
  };

  const created: { title: string; id: string }[] = [];
  // `index` is the task's position in the request, so the watch retries exactly the failed ones.
  const failed: { index: number; title: string; error: string }[] = [];
  // Sequential: keeps TickTick's ordering and stays clear of its rate limits.
  for (const [index, task] of tasks.entries()) {
    try {
      created.push({ title: task.title, id: await createTask(env.TICKTICK_TOKEN, task, tz) });
    } catch (error) {
      if (error instanceof TickTickAuthError) {
        console.error(JSON.stringify({ message: "tasks", requestId, outcome: "ticktick_auth_expired", created: created.length }));
        recordSubmission(created.length, tasks.length - created.length);
        return Response.json({ error: "ticktick_auth_expired", created }, { status: 502 });
      }
      failed.push({ index, title: task.title, error: "ticktick_failed" });
      console.error(JSON.stringify({ message: "ticktick create failed", requestId, index, error: errorSummary(error) }));
    }
  }
  console.log(JSON.stringify({ message: "tasks", requestId, created: created.length, failed: failed.length }));
  recordSubmission(created.length, failed.length);
  return Response.json({ created, failed });
}

export { Quota } from "./quota";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("cf-ray") ?? crypto.randomUUID();
    try {
      if (!(await isAuthorized(request, env.APP_TOKEN))) return errorResponse(401, "unauthorized");
      // After auth, so unauthenticated floods can't lock out the watch. One quota per credential.
      const verdict = await env.QUOTA.getByName("app-token").consume(url.pathname === "/extract" ? "extract" : "other");
      if (!verdict.ok) {
        console.log(JSON.stringify({ message: "rate limited", requestId, path: url.pathname, retryAfter: verdict.retryAfterSeconds }));
        return Response.json({ error: "rate_limited" }, { status: 429, headers: { "Retry-After": String(verdict.retryAfterSeconds) } });
      }
      if (url.pathname !== "/extract" && url.pathname !== "/tasks") return errorResponse(404, "not_found");
      if (request.method !== "POST") return errorResponse(405, "method_not_allowed");
      return url.pathname === "/extract"
        ? await handleExtract(request, env, ctx, url, requestId)
        : await handleTasks(request, env, ctx, requestId);
    } catch (error) {
      console.error(JSON.stringify({ message: "unhandled error", requestId, path: url.pathname, error: errorSummary(error) }));
      return errorResponse(500, "internal");
    }
  },

  async queue(batch, env): Promise<void> {
    await consumeHistory(batch, env.DB);
  },

  /** Daily retention purge; a no-op while HISTORY_RETENTION_DAYS is "0". */
  async scheduled(controller, env): Promise<void> {
    const days = Number(env.HISTORY_RETENTION_DAYS);
    if (!(days > 0)) return;
    const purged = await purgeHistory(env.DB, env.AUDIO, controller.scheduledTime - days * 86_400_000);
    console.log(JSON.stringify({ message: "history purged", days, ...purged }));
  },
} satisfies ExportedHandler<Env>;
