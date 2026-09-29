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
});
