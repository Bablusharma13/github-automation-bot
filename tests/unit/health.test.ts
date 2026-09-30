import { afterEach, describe, expect, it, vi } from "vitest";

describe("GET /api/health", () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
    delete (globalThis as { __automationBotDb?: unknown }).__automationBotDb;
  });

  it("reports invalid configuration without naming or echoing variables", async () => {
    process.env.GITHUB_CLIENT_SECRET = "";
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body).toEqual({ status: "degraded", config: "invalid", database: "unknown" });
    expect(JSON.stringify(body)).not.toContain("GITHUB_CLIENT_SECRET");
  });

  it("distinguishes an unreachable database from a configuration problem", async () => {
    // Port 1 on localhost refuses immediately, so this stays fast.
    process.env.DATABASE_URL = "postgres://user:pass@127.0.0.1:1/none";
    const { GET } = await import("@/app/api/health/route");
    const res = await GET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: "degraded", config: "ok", database: "unreachable" });
  });
});
