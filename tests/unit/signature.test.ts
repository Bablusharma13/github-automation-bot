import { describe, expect, it } from "vitest";
import { signPayload, verifySignature } from "@/server/webhooks/signature";

describe("GitHub webhook signature", () => {
  it("matches the test vector published in GitHub's 'Validating webhook deliveries' docs", () => {
    expect(signPayload("It's a Secret to Everybody", "Hello, World!")).toBe(
      "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17",
    );
  });

  it("verifies only the exact bytes that were signed", () => {
    const secret = "s3cret-value-0123456789";
    const body = Buffer.from('{"a": 1,  "b": "héllo"}', "utf8");
    const sig = signPayload(secret, body);
    expect(verifySignature(secret, body, sig)).toBe(true);
    // Re-serialising the JSON changes the bytes, so its signature must not verify.
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(body.toString("utf8"))), "utf8");
    expect(verifySignature(secret, reserialised, sig)).toBe(false);
  });

  it("rejects wrong secrets, missing/other prefixes and truncated signatures", () => {
    const body = Buffer.from("payload");
    const sig = signPayload("right-secret-0123456789", body);
    expect(verifySignature("wrong-secret-0123456789", body, sig)).toBe(false);
    expect(verifySignature("right-secret-0123456789", body, null)).toBe(false);
    expect(verifySignature("right-secret-0123456789", body, sig.replace("sha256=", "sha1="))).toBe(false);
    expect(verifySignature("right-secret-0123456789", body, sig.slice(0, -2))).toBe(false);
    expect(verifySignature("right-secret-0123456789", body, sig.toUpperCase())).toBe(false);
  });
});
