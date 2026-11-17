// Shared by the laptop CLIs (history.ts, vocab.ts): run wrangler with your Cloudflare login and query
// the remote D1 database.

const WRANGLER = new URL("./wrangler.sh", import.meta.url).pathname;
export const DB = "unramble";

export function wrangler(args: string[]): string {
  const run = Bun.spawnSync([WRANGLER, ...args], { stdout: "pipe", stderr: "pipe" });
  if (run.exitCode !== 0) {
    console.error(run.stderr.toString() || run.stdout.toString());
    process.exit(run.exitCode ?? 1);
  }
  return run.stdout.toString();
}

/** SQL string literal: wrangler d1 execute has no bound parameters, so escape quotes. */
export const sqlString = (value: string) => `'${value.replaceAll("'", "''")}'`;

export function query<T>(sql: string): T[] {
  const out = wrangler(["d1", "execute", DB, "--remote", "--json", "--command", sql]);
  return (JSON.parse(out.slice(out.indexOf("["))) as { results: T[] }[])[0]!.results;
}
