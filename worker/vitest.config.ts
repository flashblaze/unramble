import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests never call Workers AI; skip the remote proxy session (and its auth and shutdown delay).
      remoteBindings: false,
      miniflare: {
        bindings: {
          APP_TOKEN: "test-app-token",
          TICKTICK_TOKEN: "test-ticktick-token",
          // Applied to the local D1 by test/apply-migrations.ts.
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, "migrations")),
        },
      },
    })),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
