// Manage the vocabulary hint list (PLAN.md, Phase 2c). The Worker picks changes up within 5 minutes.
//
//   bun run vocab                         list
//   bun run vocab add "Priya Sharma" Unramble
//   bun run vocab remove Priya
//   bun run vocab suggest                 capitalised words in your transcripts that aren't listed yet
import { query, sqlString } from "./remote";

const [command = "list", ...words] = process.argv.slice(2);

function list() {
  const rows = query<{ word: string }>("SELECT word FROM vocabulary ORDER BY added_at DESC, word");
  console.log(rows.length ? rows.map((r) => `  ${r.word}`).join("\n") : "Vocabulary is empty.");
}

const clean = (word: string) => word.trim().replace(/\s+/g, " ");

if (command === "list") {
  list();
} else if (command === "add" && words.length) {
  const now = Date.now();
  const values = words.map(clean).filter(Boolean).map((w, i) => `(${sqlString(w)}, ${now + i})`);
  query(`INSERT INTO vocabulary (word, added_at) VALUES ${values.join(", ")} ON CONFLICT (word) DO UPDATE SET added_at = excluded.added_at`);
  list();
} else if (command === "remove" && words.length) {
  query(`DELETE FROM vocabulary WHERE word IN (${words.map(clean).map(sqlString).join(", ")})`);
  list();
} else if (command === "suggest") {
  const known = new Set(query<{ word: string }>("SELECT word FROM vocabulary").map((r) => r.word.toLowerCase()));
  const rows = query<{ transcript: string }>("SELECT transcript FROM dictations WHERE transcript IS NOT NULL ORDER BY created_at DESC LIMIT 500");
  // Whisper already spells these; suggesting them is noise.
  for (const common of "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december okay ok".split(" ")) known.add(common);
  const counts = new Map<string, number>();
  for (const { transcript } of rows) {
    // Capitalised words that aren't sentence starts, plus mixed-case words like "TickTick".
    for (const match of transcript.matchAll(/(?<![.!?]\s|^)\b([A-Z][a-z]+(?:[A-Z][a-z]+)*)\b/g)) {
      const word = match[1]!;
      if (word === "I" || known.has(word.toLowerCase())) continue;
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 30);
  if (!top.length) console.log("No new names found in your transcripts.");
  else {
    console.log(top.map(([w, n]) => `  ${w} (${n}×)`).join("\n"));
    console.log(`\nAdd with: bun run vocab add ${top.slice(0, 3).map(([w]) => w).join(" ")}`);
  }
} else {
  console.error("Usage: bun run vocab [list | add <word…> | remove <word…> | suggest]");
  process.exit(1);
}
