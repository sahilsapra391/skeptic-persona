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
              //
              // KNOWN MASKING, do not read these two lines as harmless.
              // Removing them yields 767 passed / 2 FAILED, both in
              // test/edgar8k.test.ts: the drain-cap test expects 10 sends and
              // gets 4, and the 304 test expects a positive drain and gets 0.
              // So the busiest source in the pipeline has its end-to-end
              // expectations pinned against a configuration production never
              // runs. Neutralising a variable to isolate a suite is fine;
              // neutralising it until a real disagreement disappears is not,
              // and the second is what is happening to edgar_8k today.
              //
              // Owned by p4-03 (salience), not by this chunk — tracked against
              // PR #79 rather than fixed here, because the right fix is either
              // edgar_8k's expectations or its salience scores, and deciding
              // which belongs with the scorer.
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
