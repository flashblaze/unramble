import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Tests never call Workers AI; skip the remote proxy session (and its auth and shutdown delay).
      remoteBindings: false,
      miniflare: { bindings: { APP_TOKEN: "test-app-token", TICKTICK_TOKEN: "test-ticktick-token" } },
    }),
  ],
});
