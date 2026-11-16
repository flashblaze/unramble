// TickTick OAuth on the laptop. TickTick's Open API issues no refresh token (tokens last 180 days),
// so rerun `bun run auth` whenever the watch reports `ticktick_auth_expired`.
// Reads TICKTICK_CLIENT_ID / TICKTICK_CLIENT_SECRET from worker/.env (Bun loads it), writes
// TICKTICK_TOKEN to worker/.dev.vars for local dev and uploads it as the deployed Worker's secret.
import { chmod } from "node:fs/promises";

const PORT = 8765;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = "tasks:write tasks:read";
const DEV_VARS = new URL("../.dev.vars", import.meta.url).pathname;

const clientId = process.env.TICKTICK_CLIENT_ID;
const clientSecret = process.env.TICKTICK_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error("Set TICKTICK_CLIENT_ID and TICKTICK_CLIENT_SECRET in worker/.env");
  process.exit(1);
}

const state = crypto.randomUUID();
const authorizeUrl =
  "https://ticktick.com/oauth/authorize?" +
  new URLSearchParams({ client_id: clientId, scope: SCOPE, state, redirect_uri: REDIRECT_URI, response_type: "code" });

async function exchange(code: string): Promise<{ access_token: string; expires_in?: number }> {
  const res = await fetch("https://ticktick.com/oauth/token", {
    method: "POST",
    headers: {
      Authorization: "Basic " + btoa(`${clientId}:${clientSecret}`),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ code, grant_type: "authorization_code", scope: SCOPE, redirect_uri: REDIRECT_URI }),
  });
  const body = await res.text();
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${body}`);
  return JSON.parse(body);
}

async function saveDevVar(key: string, value: string) {
  const file = Bun.file(DEV_VARS);
  const lines = (await file.exists()) ? (await file.text()).split("\n").filter((l) => l && !l.startsWith(`${key}=`)) : [];
  lines.push(`${key}=${value}`);
  await Bun.write(DEV_VARS, lines.join("\n") + "\n");
  await chmod(DEV_VARS, 0o600);
}

const done = Promise.withResolvers<string>();
const server = Bun.serve({
  port: PORT,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/callback") return new Response("Not found", { status: 404 });
    if (url.searchParams.get("state") !== state) return new Response("State mismatch", { status: 400 });
    const code = url.searchParams.get("code");
    if (!code) return new Response("Missing code", { status: 400 });
    try {
      const token = await exchange(code);
      await saveDevVar("TICKTICK_TOKEN", token.access_token);
      const days = token.expires_in ? ` (expires in ${Math.round(token.expires_in / 86400)} days)` : "";
      console.log(`TickTick token saved to worker/.dev.vars${days}`);
      done.resolve(token.access_token);
      return new Response("TickTick connected. You can close this tab.");
    } catch (err) {
      done.reject(err);
      return new Response(String(err), { status: 500 });
    }
  },
});

console.log(`Open this URL to authorize TickTick:\n${authorizeUrl}`);
Bun.spawn(["xdg-open", authorizeUrl], { stdout: "ignore", stderr: "ignore" });

let token: string;
try {
  token = await done.promise;
} finally {
  server.stop();
}

const upload = Bun.spawn([new URL("./wrangler.sh", import.meta.url).pathname, "secret", "put", "TICKTICK_TOKEN"], {
  stdin: new TextEncoder().encode(token),
  stdout: "inherit",
  stderr: "inherit",
});
if ((await upload.exited) !== 0) {
  console.error("Uploading TICKTICK_TOKEN to the Worker failed; retry with: bun run wrangler secret put TICKTICK_TOKEN");
  process.exit(1);
}
