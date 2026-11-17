import { Buffer } from "node:buffer";
import { z } from "zod";
import { promptClock } from "./dates";
import { errorSummary } from "./errors";
import { tasksFromModel, type Task } from "./tasks";

const WHISPER = "@cf/openai/whisper-large-v3-turbo";
const PRIMARY_MODEL = "@cf/openai/gpt-oss-120b";
const FALLBACK_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
/** gpt-oss-120b p50 is ~8 s but occasionally stalls 30–60 s; llama-3.3-70b answers in ~4 s (29/30 in Phase 0). */
const PRIMARY_TIMEOUT_MS = 25_000;

/** Whisper's usual inventions on silence; a transcript made only of these means nothing was said. */
const SILENCE_HALLUCINATIONS = /\b(thank you|thanks for watching|you)\b/gi;

export async function transcribe(ai: Ai, audio: Uint8Array): Promise<string> {
  const result = await ai.run(WHISPER, {
    audio: Buffer.from(audio).toString("base64"),
    language: "en",
    vad_filter: true,
    condition_on_previous_text: false,
  });
  return result.text.trim();
}

export function isSilence(transcript: string): boolean {
  return transcript.replace(SILENCE_HALLUCINATIONS, "").replace(/[\W_]+/g, "") === "";
}

// Field order matters: the model quotes the speaker before converting (see PLAN.md, Phase 0).
const TASKS_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          when_said: { type: "string" },
          due: { type: "string" },
          priority_said: { type: "string" },
          priority: { type: "integer", enum: [0, 1, 3, 5] },
          notes: { type: "string" },
        },
        required: ["title", "priority"],
      },
    },
  },
  required: ["tasks"],
};

export function systemPrompt(now: number, tz: string): string {
  const clock = promptClock(now, tz);
  return `You extract to-do tasks from a voice dictation transcript. The speaker is dictating their own tasks.

Current local time: ${clock.now} (${tz}).
Calendar (look dates up here; do not compute weekdays yourself):
${clock.calendar.join("\n")}
In 1/2/3 hours: ${clock.inHours.join(" / ")}

For each task, fill fields in this order:
1. title: short imperative phrase, max 80 characters, keeping names and specifics. No date or time words.
2. when_said: the speaker's exact words about WHEN this task happens ("tomorrow around ten", "by Thursday evening"). Omit if they said nothing about timing for this task.
3. due: omit if when_said is omitted. Otherwise convert when_said: "YYYY-MM-DD" for a day, "YYYY-MM-DDTHH:MM" (24h) if a time is stated.
   today / tomorrow: from the calendar. A weekday name, or "next <weekday>": the first row after today with that weekday. "next week" alone: the first Monday after today. "this weekend": the first Saturday after today.
   "by X" = X. "before X" = the row above X. "in N hours": the list above. Arithmetic ("a week before X"): X minus that many days.
   morning 09:00, afternoon 14:00, evening 18:00, tonight 20:00, end of day 18:00. No time words = date only.
4. priority_said: the speaker's exact words about importance ("urgent", "high priority"). Omit if none.
5. priority: 0 if priority_said is omitted. Otherwise 5 for urgent / ASAP / important / high, 3 for medium, 1 for low.
6. notes: only for extra details such as item lists. Otherwise omit.

Which tasks: one per distinct action the speaker must do or wants to be reminded of. Skip filler, thinking aloud, things other people will do, anything the speaker dismisses ("never mind", "not a task"), and a stray "thank you". If the speaker corrects themselves, keep only the corrected version.
No tasks: return {"tasks": []}.`;
}

/** Text-generation output: OpenAI chat-completions shape, or Workers AI `{response}` (string or parsed object). */
const ModelResult = z.union([
  z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) }),
  z.object({ response: z.union([z.string(), z.record(z.string(), z.unknown())]) }),
]);

function modelJson(result: unknown): unknown {
  const parsed = ModelResult.parse(result);
  const content = "choices" in parsed ? parsed.choices[0]!.message.content : parsed.response;
  return typeof content === "string" ? JSON.parse(content) : content;
}

export interface Extraction {
  tasks: Task[];
  model: string;
}

/** gpt-oss-120b first; on an error, malformed JSON or a stall past 25 s, one retry with llama-3.3-70b. */
export async function extractTasks(ai: Ai, transcript: string, now: number, tz: string): Promise<Extraction> {
  const messages = [
    { role: "system" as const, content: systemPrompt(now, tz) },
    { role: "user" as const, content: transcript },
  ];
  try {
    // The signal cancels the stalled request itself, so it stops consuming neurons.
    const result = await ai.run(
      PRIMARY_MODEL,
      {
        messages,
        response_format: { type: "json_schema", json_schema: { name: "tasks", schema: TASKS_SCHEMA } },
        reasoning_effort: "low",
        temperature: 0,
        max_tokens: 4000,
      },
      { signal: AbortSignal.timeout(PRIMARY_TIMEOUT_MS) },
    );
    return { tasks: tasksFromModel(modelJson(result), { now, tz }), model: PRIMARY_MODEL };
  } catch (error) {
    console.error(JSON.stringify({ message: "primary model failed", model: PRIMARY_MODEL, error: errorSummary(error) }));
  }
  const result = await ai.run(FALLBACK_MODEL, {
    messages,
    response_format: { type: "json_schema", json_schema: TASKS_SCHEMA },
    temperature: 0,
    max_tokens: 2000,
  });
  return { tasks: tasksFromModel(modelJson(result), { now, tz }), model: FALLBACK_MODEL };
}
