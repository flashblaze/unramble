import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { isSilence, systemPrompt } from "../src/extract";
import worker from "../src/index";
import { loadVocabulary, resetVocabularyCache, whisperPrompt } from "../src/vocabulary";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

beforeEach(() => resetVocabularyCache());

describe("loadVocabulary", () => {
  it("returns the seeded words, newest first, and caches them", async () => {
    await env.DB.prepare("INSERT INTO vocabulary (word, added_at) VALUES ('Priya', 5) ON CONFLICT DO NOTHING").run();
    expect(await loadVocabulary(env.DB, 1000)).toEqual(["Priya", "TickTick", "Unramble"]);
    await env.DB.prepare("INSERT INTO vocabulary (word, added_at) VALUES ('Rahul', 6)").run();
    expect(await loadVocabulary(env.DB, 1000 + 60_000)).not.toContain("Rahul"); // still cached
    expect(await loadVocabulary(env.DB, 1000 + 6 * 60_000)).toContain("Rahul"); // cache expired
  });

  it("never blocks a dictation: a D1 error yields an empty list", async () => {
    const broken = { prepare: () => ({ bind: () => ({ all: () => Promise.reject(new Error("D1 down")) }) }) } as unknown as D1Database;
    expect(await loadVocabulary(broken)).toEqual([]);
  });
});

describe("whisperPrompt", () => {
  it("frames the words and stays within Whisper's prompt budget", () => {
    expect(whisperPrompt([])).toBeUndefined();
    expect(whisperPrompt(["Unramble", "TickTick"])).toBe("Vocabulary: Unramble, TickTick.");
    expect(whisperPrompt(Array.from({ length: 300 }, (_, i) => `Word${i}`))!.length).toBeLessThanOrEqual(701);
  });
});

describe("prompts", () => {
  it("tells the extraction model the correct spellings", () => {
    expect(systemPrompt(0, "UTC", ["Unramble", "Priya"])).toContain("Correct spellings of names and words the speaker uses (the transcript may misspell them): Unramble, Priya.");
    expect(systemPrompt(0, "UTC")).not.toContain("Correct spellings");
  });

  it("treats Whisper echoing the vocabulary prompt on silence as silence", () => {
    expect(isSilence("Vocabulary: Unramble, TickTick.", ["Unramble", "TickTick"])).toBe(true);
    expect(isSilence("Test Unramble tomorrow.", ["Unramble", "TickTick"])).toBe(false);
  });

  it("/extract sends the vocabulary to Whisper as initial_prompt", async () => {
    const calls: Record<string, unknown>[] = [];
    const ai = {
      run: async (model: string, input: Record<string, unknown>) => {
        calls.push(input);
        return model.includes("whisper") ? { text: "Test Unramble tomorrow." } : { choices: [{ message: { content: '{"tasks":[]}' } }] };
      },
    } as unknown as Ai;
    const ctx = createExecutionContext();
    const res = await worker.fetch!(
      new IncomingRequest("https://unramble.test/extract?tz=UTC", { method: "POST", headers: { Authorization: "Bearer test-app-token" }, body: new Uint8Array([1]) }),
      { ...env, AI: ai },
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(res.status).toBe(200);
    expect(calls[0]!.initial_prompt).toMatch(/^Vocabulary: .*Unramble.*TickTick|^Vocabulary: .*TickTick.*Unramble/);
  });
});
