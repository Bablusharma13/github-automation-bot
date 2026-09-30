// Deterministic, obviously-fake values for tests. Never real credentials.
process.env.APP_URL = "http://localhost:3000";
process.env.DATABASE_URL = "postgres://unused-in-tests";
process.env.GITHUB_CLIENT_ID = "test-client-id";
process.env.GITHUB_CLIENT_SECRET = "test-client-secret";
process.env.GITHUB_WEBHOOK_SECRET = "test-webhook-secret-0123456789";
process.env.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.CRON_SECRET = "test-cron-secret-0123456789";
process.env.SLACK_WEBHOOK_URL = "";

// Tests must never reach the network: every external call is mocked per test with
// mockFetch(). If a test forgets to, fail loudly instead of calling the real GitHub/Slack.
// (vi.unstubAllGlobals() restores this guard, since it is fetch's value at stub time.)
globalThis.fetch = async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : input.toString();
  throw new Error(`Real network access is disabled in tests (attempted: ${url})`);
};
