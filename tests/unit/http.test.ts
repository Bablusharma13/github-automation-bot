import { describe, expect, it } from "vitest";
import { clientIp, isSameOrigin } from "@/server/http/request";

describe("clientIp", () => {
  it("uses the first x-forwarded-for entry", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "198.51.100.7, 10.0.0.1" }))).toBe("198.51.100.7");
  });
  it("prefers x-vercel-forwarded-for", () => {
    expect(
      clientIp(new Headers({ "x-vercel-forwarded-for": "198.51.100.9", "x-forwarded-for": "1.1.1.1" })),
    ).toBe("198.51.100.9");
  });
  it("falls back to unknown", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });
});

describe("isSameOrigin", () => {
  const app = "https://bot.example.com";
  it("accepts the exact app origin", () => {
    expect(isSameOrigin(new Headers({ origin: app }), app)).toBe(true);
  });
  it("rejects other origins, lookalikes, missing and null origins", () => {
    expect(isSameOrigin(new Headers({ origin: "https://evil.example" }), app)).toBe(false);
    expect(isSameOrigin(new Headers({ origin: "https://bot.example.com.evil.example" }), app)).toBe(false);
    expect(isSameOrigin(new Headers({ origin: "http://bot.example.com" }), app)).toBe(false);
    expect(isSameOrigin(new Headers({ origin: "null" }), app)).toBe(false);
    expect(isSameOrigin(new Headers(), app)).toBe(false);
  });
});
