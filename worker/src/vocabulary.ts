// Vocabulary hints (PLAN.md, Phase 2c): words Whisper rarely hears ("Unramble", names) are passed as
// Whisper's initial_prompt and to the extraction prompt so both spell them your way.
import { errorSummary } from "./errors";

/** Whisper's prompt window is ~224 tokens; leave room for the "Vocabulary:" framing. */
const MAX_WORDS = 150;
const MAX_CHARS = 700;
const CACHE_MS = 5 * 60_000;

let cache: { words: string[]; at: number } | undefined;

/** Most recently added first, capped. Cached per isolate; on a D1 error returns [] (never blocks a dictation). */
export async function loadVocabulary(db: D1Database, now = Date.now()): Promise<string[]> {
  if (cache && now - cache.at < CACHE_MS) return cache.words;
  try {
    const { results } = await db
      .prepare("SELECT word FROM vocabulary ORDER BY added_at DESC, word LIMIT ?")
      .bind(MAX_WORDS)
      .all<{ word: string }>();
    cache = { words: results.map((r) => r.word), at: now };
    return cache.words;
  } catch (error) {
    console.error(JSON.stringify({ message: "vocabulary load failed", error: errorSummary(error) }));
    return [];
  }
}

/** Test seam: forget the cached list. */
export function resetVocabularyCache(): void {
  cache = undefined;
}

/** Whisper initial_prompt, or undefined when there's nothing to hint. Stops before MAX_CHARS. */
export function whisperPrompt(words: string[]): string | undefined {
  let prompt = "Vocabulary:";
  for (const word of words) {
    const next = `${prompt}${prompt.endsWith(":") ? " " : ", "}${word}`;
    if (next.length > MAX_CHARS) break;
    prompt = next;
  }
  return prompt === "Vocabulary:" ? undefined : `${prompt}.`;
}
