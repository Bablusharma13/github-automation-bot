// Deterministic, obviously-fake values for tests. Never real credentials.
process.env.APP_URL = "http://localhost:3000";
process.env.DATABASE_URL = "postgres://unused-in-tests";
process.env.GITHUB_CLIENT_ID = "test-client-id";
process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret-0123456789";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.CRON_SECRET = "test-cron-secret-0123456789";
process.env.SLACK_WEBHOOK_URL = "";
