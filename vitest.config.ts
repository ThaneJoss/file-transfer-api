import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@simplewebauthn\/server$/u,
        replacement: path.resolve("./test/simplewebauthn-server.ts"),
      },
    ],
  },
  plugins: [
    cloudflareTest(async () => ({
      main: "./src/index.ts",
      miniflare: {
        compatibilityDate: "2026-06-19",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["DB"],
        durableObjects: {
          PICKUP_SESSIONS: { className: "PickupSession", useSQLite: true },
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
          BETTER_AUTH_URL: "https://api.file.thanejoss.com",
          APP_ORIGIN: "https://file.thanejoss.com",
          TURN_KEY_ID: "test",
          TURN_KEY_API_TOKEN: "test",
          R2_ACCOUNT_ID: "test",
          R2_BUCKET: "test",
          R2_PARENT_API_TOKEN: "test",
          R2_PARENT_ACCESS_KEY_ID: "test",
          SFU_APP_ID: "test",
          SFU_APP_TOKEN: "test",
        },
      },
    })),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
