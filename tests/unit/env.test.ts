import { afterEach, describe, expect, it, vi } from "vitest";

describe("getEnv", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
  });

  it("parses the test environment and strips a trailing slash from APP_URL", async () => {
    process.env.APP_URL = "https://example.test/";
    const { getEnv } = await import("@/server/env");
    const env = getEnv();
    expect(env.APP_URL).toBe("https://example.test");
    expect(env.SLACK_WEBHOOK_URL).toBeUndefined();
  });

  it("names invalid variables without echoing their values", async () => {
    process.env.TOKEN_ENCRYPTION_KEY = "not-32-bytes-super-secret-value";
    const { getEnv } = await import("@/server/env");
    let message = "";
    try {
      getEnv();
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toContain("TOKEN_ENCRYPTION_KEY");
    expect(message).not.toContain("not-32-bytes-super-secret-value");
  });

  it("rejects an APP_URL with a path (OAuth callback and webhook URLs are derived from it)", async () => {
    process.env.APP_URL = "https://example.test/app";
    const { getEnv } = await import("@/server/env");
    expect(() => getEnv()).toThrow(/APP_URL/);
  });

  it("requires https for a non-local APP_URL in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    try {
      process.env.APP_URL = "http://bot.example.com";
      const insecure = await import("@/server/env");
      expect(() => insecure.getEnv()).toThrow(/APP_URL: must use https in production/);

      vi.resetModules();
      process.env.APP_URL = "http://localhost:3000";
      const local = await import("@/server/env");
      expect(local.getEnv().APP_URL).toBe("http://localhost:3000");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
