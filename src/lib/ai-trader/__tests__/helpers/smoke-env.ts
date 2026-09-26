// Must be imported before any route module: m5-close / h1-strategy read their
// secrets at module load.  With an unset secret the handlers correctly fail
// closed with 401, which used to mask every assertion behind the auth check.
// The tests still send these values in the auth headers, so auth stays exercised.
// Always overwrite so real secrets from a shell / --env-file are never used.
process.env.WATCHER_SECRET = "stage4-smoke-watcher-secret";
process.env.CRON_SECRET    = "stage4-smoke-cron-secret";
