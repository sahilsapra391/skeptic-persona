import { applyD1Migrations, env } from "cloudflare:test";

// Runs before each test file; isolated storage gives every test a clean DB
// snapshot taken after these migrations are applied.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
