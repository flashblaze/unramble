// Browse saved dictations (D1) and their audio (R2) from the laptop. Reads go through your Cloudflare
// login (scripts/wrangler.sh); the Worker has no HTTP read path by design.
//
//   bun run history                         last 20 dictations
//   bun run history --limit 50
//   bun run history --search "plumber"      full-text search over transcripts
//   bun run history --id <id>               one dictation, full JSON
//   bun run history --play <id>             download the audio and play it
//   bun run history --save <id> <file.ogg>  download the audio
//   bun run history --purge-older-than 90d [--yes]
import { tmpdir } from "node:os";
import { join } from "node:path";

const WRANGLER = new URL("./wrangler.sh", import.meta.url).pathname;
const DB = "unramble";
const BUCKET = "unramble-audio";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Task = { title: string; due?: string; priority: number; notes?: string };
type Row = {
  id: string;
  created_at: number;
  tz: string;
  outcome: string;
  error: string | null;
  transcript: string | null;
  extracted_json: string | null;
  model: string | null;
  audio_key: string | null;
  audio_bytes: number;
  audio_error: string | null;
  whisper_ms: number | null;
  llm_ms: number | null;
  submitted_json: string | null; // JSON array of submitted task arrays
  created: number;
  snippet?: string;
};

function wrangler(args: string[]): string {
  const run = Bun.spawnSync([WRANGLER, ...args], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    console.error(run.stderr.toString() || run.stdout.toString());
    process.exit(run.exitCode ?? 1);
  }
  return run.stdout.toString();
}

/** SQL string literal: wrangler d1 execute has no bound parameters, so escape quotes. */
const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

function query<T>(sql: string): T[] {
  const out = wrangler(["d1", "execute", DB, "--remote", "--json", "--command", sql]);
  return (JSON.parse(out.slice(out.indexOf("["))) as { results: T[] }[])[0]!.results;
}

const SELECT = `
  SELECT d.*,
    (SELECT json_group_array(json(s.submitted_json)) FROM submissions s WHERE s.dictation_id = d.id) AS submitted_json,
    (SELECT COALESCE(SUM(s.created_count), 0) FROM submissions s WHERE s.dictation_id = d.id) AS created
  FROM dictations d`;

function requireId(value: string | undefined): string {
  if (!value || !UUID.test(value)) {
    console.error("Expected a dictation id (UUID). Run `bun run history` to list them.");
    process.exit(1);
  }
  return value;
}

function print(row: Row) {
  const when = new Date(row.created_at).toLocaleString("en-GB", { timeZone: row.tz, dateStyle: "medium", timeStyle: "short" });
  const audio = row.audio_key ? "🎧" : row.audio_error ? `no audio (${row.audio_error})` : "no audio";
  const outcome = row.outcome === "failed" ? `FAILED (${row.error ?? "?"})` : row.outcome;
  console.log(`\n${when}  ${outcome}  ${audio}  ${row.id}`);
  const text = row.snippet ?? row.transcript;
  if (text) console.log(`  “${text}”`);
  const proposed = row.extracted_json ? (JSON.parse(row.extracted_json) as Task[]) : [];
  const kept = new Set((JSON.parse(row.submitted_json ?? "[]") as Task[][]).flat().map((t) => t.title));
  for (const task of proposed) {
    const details = [task.due, task.priority === 5 ? "high" : task.priority === 3 ? "medium" : task.priority === 1 ? "low" : null]
      .filter(Boolean)
      .join(", ");
    console.log(`  ${kept.has(task.title) ? "✓" : "·"} ${task.title}${details ? `  (${details})` : ""}`);
  }
  if (kept.size > 0 || row.created > 0) console.log(`  → ${row.created} created in TickTick`);
}

async function download(id: string, file: string) {
  const [row] = query<{ audio_key: string | null }>(`SELECT audio_key FROM dictations WHERE id = ${sqlString(id)}`);
  if (!row) return console.error("No such dictation."), process.exit(1);
  if (!row.audio_key) return console.error("This dictation has no audio."), process.exit(1);
  wrangler(["r2", "object", "get", `${BUCKET}/${row.audio_key}`, "--remote", "--file", file]);
  if (!(await Bun.file(file).exists())) return console.error("Audio has expired (R2 lifecycle rule)."), process.exit(1);
}

function play(file: string) {
  const players = [["mpv", "--no-video"], ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet"], ["xdg-open"], ["open"]];
  for (const [bin, ...args] of players) {
    if (Bun.which(bin!)) return Bun.spawnSync([bin!, ...args, file], { stdout: "inherit", stderr: "inherit" });
  }
  console.log(`No audio player found; file saved at ${file}`);
}

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : (args[i + 1] ?? "");
};

if (args.includes("--id")) {
  const id = requireId(flag("--id"));
  const [row] = query<Row>(`${SELECT} WHERE d.id = ${sqlString(id)}`);
  console.log(row ? JSON.stringify({ ...row, extracted_json: JSON.parse(row.extracted_json ?? "null"), submitted_json: JSON.parse(row.submitted_json ?? "[]") }, null, 2) : "No such dictation.");
} else if (args.includes("--play")) {
  const id = requireId(flag("--play"));
  const file = join(tmpdir(), `unramble-${id}.ogg`);
  await download(id, file);
  play(file);
} else if (args.includes("--save")) {
  const id = requireId(flag("--save"));
  const file = args[args.indexOf("--save") + 2] ?? `${id}.ogg`;
  await download(id, file);
  console.log(`Saved ${file}`);
} else if (args.includes("--search")) {
  const term = flag("--search") ?? "";
  // Quoted as an FTS5 phrase so punctuation in the term can't become query syntax.
  const match = sqlString(`"${term.replaceAll('"', '""')}"`);
  const rows = query<Row>(
    `SELECT x.*, highlight(dictations_fts, 0, '[', ']') AS snippet FROM dictations_fts
     JOIN (${SELECT}) x ON x.rowid = dictations_fts.rowid
     WHERE dictations_fts MATCH ${match} ORDER BY x.created_at DESC LIMIT 50`.replace("SELECT d.*", "SELECT d.rowid, d.*"),
  );
  if (rows.length === 0) console.log(`No dictations mention “${term}”.`);
  rows.forEach(print);
} else if (args.includes("--purge-older-than")) {
  const spec = flag("--purge-older-than") ?? "";
  const days = Number(/^(\d+)d$/.exec(spec)?.[1]);
  if (!(days > 0)) {
    console.error("Usage: --purge-older-than <days>d, e.g. 90d");
    process.exit(1);
  }
  const cutoff = Date.now() - days * 86_400_000;
  const rows = query<{ id: string; audio_key: string | null }>(`SELECT id, audio_key FROM dictations WHERE created_at < ${cutoff}`);
  if (!args.includes("--yes")) {
    console.log(`Would delete ${rows.length} dictation(s) older than ${days} days and their audio. Re-run with --yes.`);
  } else {
    for (const row of rows) if (row.audio_key) wrangler(["r2", "object", "delete", `${BUCKET}/${row.audio_key}`, "--remote"]);
    query(`DELETE FROM submissions WHERE created_at < ${cutoff}`);
    query(`DELETE FROM dictations WHERE created_at < ${cutoff}`);
    console.log(`Deleted ${rows.length} dictation(s).`);
  }
} else {
  const limit = Number(flag("--limit") ?? 20);
  const rows = query<Row>(`${SELECT} ORDER BY d.created_at DESC LIMIT ${Number.isInteger(limit) && limit > 0 ? limit : 20}`);
  if (rows.length === 0) console.log("No dictations saved yet.");
  rows.reverse().forEach(print);
}
