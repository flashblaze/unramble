# Voice → TickTick tasks (Galaxy Watch 8)

Press a button on the watch, dictate, review the extracted tasks, and send them to the TickTick Inbox.

## Decisions

| Topic | Choice | Why |
|---|---|---|
| Speech source | Dictation only: every word you say counts | No speaker separation needed, so it's more accurate |
| After processing | Review screen on the watch with toggles, then **Create** | Bad extractions never reach TickTick |
| AI provider | Cloudflare Workers AI: `@cf/openai/whisper-large-v3-turbo` + `@cf/openai/gpt-oss-120b` (JSON mode, `reasoning_effort: low`), falling back to `@cf/meta/llama-3.3-70b-instruct-fp8-fast` on error or after 25 s | Free at personal volume, one account, no extra API keys; Whisper on Workers AI is zero-data-retention; gpt-oss-120b scored 30/30 in Phase 0 |
| TickTick list | Inbox | — |
| Language | English (`language: "en"` passed to Whisper) | — |
| Max recording | 5 min, then it stops automatically | Ogg/Opus 16 kHz mono 24 kbps: about 800 KB, uploads in one go |
| Phone app | None | The watch talks to the Worker directly over Wi-Fi/LTE/Bluetooth proxy |

### Cost (Workers AI free allowance: 10,000 neurons/day)

Measured in Phase 0: Whisper 47 neurons per audio minute; gpt-oss-120b about 50 neurons per extraction (≈1k-token prompt).

| Per recording | Whisper | LLM | Total |
|---|---|---|---|
| 1 min | 47 | ~50 | ~100 neurons → ~100 recordings/day free |
| 5 min | 233 | ~50 | ~285 neurons → ~35 recordings/day free |

Above the free allowance (Workers Paid plan only): $0.011 per 1,000 neurons, about $0.003 per 5-minute recording.

## Architecture

```mermaid
sequenceDiagram
  participant W as Watch app
  participant CF as Worker (voice-tasks)
  participant AI as Workers AI
  participant TT as TickTick API
  W->>CF: POST /extract (audio, tz, now) + Bearer APP_TOKEN
  CF->>AI: whisper-large-v3-turbo (en, vad_filter)
  AI-->>CF: transcript
  CF->>AI: gpt-oss-120b JSON mode (transcript, calendar, tz)
  AI-->>CF: {tasks:[...]}
  CF-->>W: {transcript, tasks}
  Note over W: user unticks unwanted tasks
  W->>CF: POST /tasks {tasks, tz} + Bearer APP_TOKEN
  CF->>TT: POST /open/v1/task (one per task, Inbox)
  TT-->>CF: created
  CF-->>W: {created:n, failed:[...]}
```

Secrets are stored only as Worker secrets: `APP_TOKEN` (watch → Worker) and `TICKTICK_TOKEN`. The watch app holds only `APP_TOKEN`, read from `local.properties` into `BuildConfig` at build time, so it never reaches git. The Worker never stores audio.

## Repository layout

```
watch-app/
  app/                    Wear OS app (Compose for Wear OS, Material3)
  worker/                 Cloudflare Worker (TypeScript, wrangler)
    src/index.ts          router, bearer auth, body limits, structured logs
    src/extract.ts        Whisper, prompt, gpt-oss-120b → llama fallback
    src/tasks.ts          zod schemas: Task, /tasks body, model output + grounding guard
    src/dates.ts          time-zone math: prompt calendar, local due → TickTick date
    src/ticktick.ts       TickTick client (Inbox)
    scripts/auth.ts       TickTick OAuth on the laptop → .dev.vars + Worker secret
    scripts/wrangler.sh   runs wrangler with the cf CLI login
    test/                 vitest in the Workers runtime (@cloudflare/vitest-plugin)
  PLAN.md
```

## Task JSON (the contract between LLM, Worker and watch)

The LLM returns, per task (field order matters, see Phase 0):
`title`, `when_said` (your exact timing words), `due`, `priority_said` (your exact importance words), `priority`, `notes`.

The Worker enforces the grounding in code: no `when_said` → `due` dropped; no `priority_said` → `priority = 0`. It then returns this to the watch:

```json
{
  "transcript": "remind me to call the bank tomorrow at 10 and also buy milk",
  "tasks": [
    { "title": "Call the bank", "due": "2026-11-17T10:00", "priority": 0 },
    { "title": "Buy milk", "priority": 0 }
  ]
}
```
- `due` is local time without an offset: `YYYY-MM-DD` (all day) or `YYYY-MM-DDTHH:MM` (timed), or absent. The watch sends its zone (e.g. `Asia/Kolkata`), and the Worker converts to TickTick's `yyyy-MM-dd'T'HH:mm:ssZ` (with offset) plus `timeZone`. Phase 0 confirmed `2026-11-17T10:00:00+0530` with `timeZone: Asia/Kolkata` is stored as 10:00 IST.
- `priority` maps to TickTick: 0 none, 1 low, 3 medium, 5 high.
- `notes` (optional) becomes the TickTick task `content`.
- The Worker validates every field (title 1–200 chars, date parses, priority in the allowed set). Invalid items are dropped, never sent to TickTick.

## Phases

### Phase 0: risk spikes ✅ done 2026-11-16
Harness and samples: `worker/spike/` (gitignored). Prompt to port: `worker/spike/prompt-v4.txt`, schema: `worker/spike/schema-v4.json`.

1. **Whisper input ✅** Test audio was a TTS-generated dictation, looped to 5 min, 16 kHz mono.

   | Clip | Size | Time | Result |
   |---|---|---|---|
   | 5 min Ogg/Opus 24 kbps | 804 KB | 25.6 s | 920 words, accurate |
   | 5 min M4A/AAC 32 kbps | 1.17 MB | 35.2 s | 921 words, accurate |

   Single call, no splitting needed. **Use Ogg/Opus**: smaller and faster.
   Quirks: Whisper invents a "Thank you." on trailing silence, and long audio loses capitalization partway through. The prompt ignores a stray "thank you"; casing doesn't matter to the LLM.
2. **LLM extraction ✅** 10 cases (multi-task ramble, no tasks, no date, time today, self-correction, recurring, other people's actions, item list, "in two hours" across midnight, "a week before Dec 3"), 3 runs each, scored automatically.

   | Prompt | llama-3.3-70b | gpt-oss-120b | qwen3-30b |
   |---|---|---|---|
   | v1: plain rules | ~5/10 | — | — |
   | v2: + 15-day calendar table | 8/10 | 9/10 | 9/10 |
   | v3: + 45-day calendar | 24/30 | 26/30 | 26/30 |
   | **v4: 21-day calendar + `when_said`/`priority_said` grounding + code guard** | 29/30 | **30/30** | 29/30 |

   What fixed it: the model looks weekdays up in a calendar instead of computing them. It must quote your timing and importance words before giving a date or priority, and the Worker drops any date or priority without a quote. gpt-oss-120b: p50 6.6 s, max 23.8 s.
3. **TickTick ✅** `scripts/auth.ts` (localhost:8765 OAuth) works, and the token lasts **180 days**. `POST /open/v1/task` **without `projectId`** lands in Inbox (`inbox117298866`). `DELETE /open/v1/project/{pid}/task/{id}` works.

Worst case per request: upload + 26 s Whisper + 24 s LLM ≈ 60 s, so the watch timeout is 120 s.

### Phase 1: Worker ✅ done 2026-11-16
Deployed at **`https://voice-tasks.flashblaze.workers.dev`**. Code in `worker/`. Commands (run in `worker/`):

| Command | What |
|---|---|
| `bun run deploy` | deploy (wrangler borrows the `cf` CLI login via `scripts/wrangler.sh`) |
| `bun run auth` | TickTick OAuth → `.dev.vars` + Worker secret `TICKTICK_TOKEN` (rerun every 180 days) |
| `bun run test` / `bun run typecheck` | 34 tests in the Workers runtime / tsc |
| `bun run types` | regenerate `worker-configuration.d.ts` after changing `wrangler.jsonc` |
| `bun run wrangler tail voice-tasks` | live logs (JSON: request ID, sizes, task count, model, whisperMs, llmMs, never transcript text) |

**API** (all routes: `POST`, `Authorization: Bearer <APP_TOKEN>`; errors are `{"error": "<code>"}`):

| Route | Body | 200 response | Errors |
|---|---|---|---|
| `/extract?tz=<IANA zone>` | raw Ogg/Opus audio, ≤ 3 MB | `{transcript, tasks: [{title, due?, priority, notes?}]}` | 400 `bad_timezone` / `empty_audio`, 413 `too_large`, 422 `no_speech` |
| `/tasks` | `{tz, tasks: [...]}` (1–20, as returned by `/extract`) | `{created: [{title, id}], failed: [{title, error}]}` | 400 `bad_request` / `bad_timezone`, 413 `too_large`, 502 `ticktick_auth_expired` (+ `created` so far) |

Shared: 401 `unauthorized` (checked before routing), 404 `not_found`, 405 `method_not_allowed`, 500 `internal`. Retry `/tasks` with only the `failed` titles, so nothing is duplicated.

**Verified:**
- `curl` with the 30 s dictation returned 5 correct tasks: dates, all-day vs timed, and priority 5 for "high priority". `/tasks` created all 5 in Inbox. Read back from TickTick: 10:00 IST is stored as `04:30Z`, all-day dates as local midnight. Test tasks deleted afterwards.
- Latency: Whisper about 5 s for 30 s of audio. gpt-oss-120b at default effort took 29 s under load. With `reasoning_effort: low` the typical response is 7.7 s and accuracy still 29/30; its one failure was the test client's own 60 s timeout. Requests that stall past 25 s fall back to llama. End to end: 30 s clip about 19–35 s, 5-min clip 57 s.
- The Worker sends gpt-oss the JSON schema in OpenAI format (`json_schema: {name, schema}`): re-evaluated at 30/30.

Gotchas:
- A first deploy with `secrets.required` needs `bun run deploy -- --secrets-file .dev.vars`, because a Worker that doesn't exist yet can't take `secret put`.
- `.dev.vars` holds `APP_TOKEN` and `TICKTICK_TOKEN`; `.env` holds the TickTick client ID and secret. Both are gitignored.

### Phase 2: watch app
- Manifest: `RECORD_AUDIO`, `INTERNET`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS`. Declare a `<service android:foregroundServiceType="microphone">`.
- `RecorderService` (foreground service, microphone type): MediaRecorder `OutputFormat.OGG` + `AudioEncoder.OPUS`, 16 kHz mono, 24 kbps, writing to `cacheDir`, auto-stop at 5:00. Starts only from the visible Record button, as Android 14+ requires. A Wear **Ongoing Activity** (`androidx.wear:wear-ongoing`) shows a recording chip on the watch face so it keeps running with the screen off.
- Screens (Compose for Wear OS Material3, one ViewModel with a `StateFlow` state machine):
  `Idle → Recording(timer, Stop, Cancel) → Uploading → Review(list of tasks with toggles, "Create N") → Done(count + haptic) | Error(message, Retry)`
  - Review shows the title, plus the due date when there is one. Tapping a row toggles it. "Create" is disabled when nothing is selected.
  - Empty result → "No tasks heard" with "Record again".
- Networking: OkHttp, 120 s timeout on `/extract`, body = recorded file, `?tz=${ZoneId.systemDefault()}`. Map error codes to messages (`no_speech` → "No speech heard", `ticktick_auth_expired` → "TickTick login expired: run `bun run auth` in worker/"). The audio file is kept until `/tasks` succeeds, so Retry never needs a re-recording, and Retry for `/tasks` resends only `failed`. `Authorization: Bearer ${BuildConfig.APP_TOKEN}`, base URL from `BuildConfig.WORKER_URL`; both come from `local.properties`, which is gitignored.
- Microphone permission: ask on first tap. If denied, explain on screen and offer to open Settings.

**Done when**, on the emulator (host mic), saying "buy milk and call mom tomorrow at 6 pm" gives a review list of 2 tasks, and Create puts both in the TickTick Inbox with the right due date.

### Phase 3: real watch
- Pair over Wi-Fi debugging and install with `./gradlew installDebug`.
- Check: recording continues with the screen off, upload works over Bluetooth-via-phone and over Wi-Fi alone, a 5-minute recording uploads and processes, and battery use for 10 recordings is acceptable.
- Mirror with `scrcpy` while testing.

**Done when** 5 real dictations in different conditions (quiet, walking, outdoors) all produce correct tasks.

### Phase 4: hardening
- `ticktick_auth_expired` → the watch shows "TickTick login expired: run `bun run auth` in worker/".
- Worker logs record request IDs, durations, task counts and error types, never transcript text.
- Upload size and duration limits enforced on both sides.
- README section: setup, secrets, re-auth, cost.

## Out of scope (possible later)
- Recording real conversations with several speakers (needs speaker separation)
- Choosing the list automatically, tags, subtasks, reminders
- A Tile or complication to start recording from the watch face
- Offline queue for recordings made with no connection
- Play Store release (needs a privacy policy and Data safety form for microphone use)

## What the user must provide
1. ✅ TickTick developer app (client ID + secret in `worker/.env`, gitignored), redirect URI `http://localhost:8765/callback`.
2. ✅ Cloudflare auth: the `cf` CLI login is used instead of `wrangler login`.
3. For Phase 3: the watch's IP, port and pairing code (from Wireless debugging).
