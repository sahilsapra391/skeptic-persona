import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      setupFiles: ["./test/setup.ts"],
      poolOptions: {
        workers: {
          singleWorker: true,
          wrangler: { configPath: "./wrangler.toml" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              // Telegram test fixtures; the API itself is fetchMock'd.
              TELEGRAM_BOT_TOKEN: "TEST:TOKEN",
              TELEGRAM_CHAT_ID: "424242",
              TELEGRAM_WEBHOOK_SECRET: "test-webhook-secret",
              QUEUE_NOTIFY_SPACING_MS: "0",
              BLS_POLL_INTERVAL_MS: "0",
              BLS_POLL_DEADLINE_MS: "300",
              INGEST_SECRET: "test-ingest-secret",
              THREADS_APP_ID: "TESTAPP",
              THREADS_APP_SECRET: "TESTSECRET",
            },
          },
        },
      },
    },
  };
});
