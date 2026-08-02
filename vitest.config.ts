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
              // p4-03: curation OFF by default in tests. Ingester suites
              // assert ingestion behaviour (dedup, drain caps, conditional
              // GET) and must not also depend on the salience thresholds of
              // the day. A floor of 0 passes everything; a bypass of 0 makes
              // every item ignore the daily caps. test/salience.test.ts turns
              // the gate back ON explicitly by spreading its own env.
              SALIENCE_FLOOR: "0",
              CAP_BYPASS_SCORE: "0",
              THREADS_APP_ID: "TESTAPP",
              THREADS_APP_SECRET: "TESTSECRET",
            },
          },
        },
      },
    },
  };
});
