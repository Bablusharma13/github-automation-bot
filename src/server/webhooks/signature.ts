import { createHmac } from "node:crypto";
import { safeEqual } from "../crypto";

/**
 * GitHub's `X-Hub-Signature-256`: "sha256=" + hex(HMAC-SHA256(secret, raw body bytes)).
 * The HMAC must be computed over the exact bytes received — parsing and re-serialising
 * the JSON first would change whitespace/escaping and break verification.
 */
export function signPayload(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
}

export function verifySignature(secret: string, rawBody: Buffer, header: string | null): boolean {
  if (!header || !header.startsWith("sha256=")) return false;
  // Constant-time comparison (never ===): see GitHub's "Validating webhook deliveries".
  return safeEqual(header, signPayload(secret, rawBody));
}
