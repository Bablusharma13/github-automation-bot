import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { logger, serializeError } from "@/server/logger";
import { ingestGitHubDelivery, MAX_WEBHOOK_BODY_BYTES } from "@/server/webhooks/ingest";

/**
 * GitHub webhook receiver. Authenticated by HMAC signature (not by session), so the
 * same-origin/session rules of the dashboard API do not apply here.
 */
export async function POST(request: NextRequest) {
  const noStore = { "Cache-Control": "no-store" };

  // Refuse obviously oversized bodies before buffering them.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_WEBHOOK_BODY_BYTES) {
    logger.warn("github_webhook_rejected", { reason: "payload_too_large", declared });
    return Response.json(
      { error: { code: "payload_too_large", message: "Payload too large." } },
      { status: 413, headers: noStore },
    );
  }

  try {
    const rawBody = Buffer.from(await request.arrayBuffer());
    const { db, env } = appDeps();
    const result = await ingestGitHubDelivery(db, env, { headers: request.headers, rawBody });
    return Response.json(result.body, { status: result.status, headers: noStore });
  } catch (err) {
    logger.error("github_webhook_unhandled", { error: serializeError(err) });
    return Response.json(
      { error: { code: "internal_error", message: "Could not process delivery." } },
      { status: 500, headers: noStore },
    );
  }
}
