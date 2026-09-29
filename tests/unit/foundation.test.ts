import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, safeEqual } from "@/server/crypto";
import { __test__ as loggerInternals } from "@/server/logger";

const KEY = Buffer.alloc(32, 1).toString("base64");

describe("encryptSecret / decryptSecret", () => {
  it("round-trips and never returns the plaintext in the ciphertext", () => {
    const secret = "gho_example_token_value";
    const enc = encryptSecret(secret, KEY);
    expect(enc).not.toContain(secret);
    expect(enc.startsWith("v1.")).toBe(true);
    expect(decryptSecret(enc, KEY)).toBe(secret);
  });

  it("uses a fresh IV per encryption", () => {
    expect(encryptSecret("same", KEY)).not.toBe(encryptSecret("same", KEY));
  });

  it("rejects tampered ciphertext (GCM auth tag)", () => {
    const enc = encryptSecret("value", KEY);
    const parts = enc.split(".");
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] = ct[0]! ^ 0xff;
    parts[3] = ct.toString("base64url");
    expect(() => decryptSecret(parts.join("."), KEY)).toThrow();
  });

  it("rejects the wrong key", () => {
    const enc = encryptSecret("value", KEY);
    expect(() => decryptSecret(enc, Buffer.alloc(32, 2).toString("base64"))).toThrow();
  });
});

describe("safeEqual", () => {
  it("compares strings of equal and unequal length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("logger redaction", () => {
  it("redacts sensitive keys recursively", () => {
    const out = loggerInternals.redact({
      deliveryId: "abc",
      accessToken: "gho_x",
      nested: { slackWebhookUrl: "https://hooks.slack.com/services/x", ok: 1 },
      headers: { authorization: "Bearer y", cookie: "s=1" },
    }) as Record<string, unknown>;
    expect(out.deliveryId).toBe("abc");
    expect(out.accessToken).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).slackWebhookUrl).toBe("[REDACTED]");
    expect((out.nested as Record<string, unknown>).ok).toBe(1);
    expect((out.headers as Record<string, unknown>).authorization).toBe("[REDACTED]");
    expect((out.headers as Record<string, unknown>).cookie).toBe("[REDACTED]");
  });
});
