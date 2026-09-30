import { after, type NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { drainJobs } from "@/server/jobs/worker";
import { logger, serializeError } from "@/server/logger";
import { ingestGitHubDelivery, MAX_WEBHOOK_BODY_BYTES } from "@/server/webhooks/ingest";

// The response goes out immediately; after() keeps processing for up to ~50s
// (retrying transient failures in place). Vercel Hobby allows up to 300s.
export const maxDuration = 60;

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

    if (result.status === 202) {
      // Never do GitHub/Slack work before answering GitHub (10s delivery timeout). The job
      // is already committed, so if this background drain dies, the sweeper picks it up.
      after(async () => {
        try {
          const stats = await drainJobs(db, env, { budgetMs: 50_000, waitForRetries: true });
          logger.info("drain_after_webhook_completed", stats);
        } catch (err) {
          logger.error("drain_after_webhook_failed", { error: serializeError(err) });
        }
      });
    }
    return Response.json(result.body, { status: result.status, headers: noStore });
  } catch (err) {
    logger.error("github_webhook_unhandled", { error: serializeError(err) });
    return Response.json(
      { error: { code: "internal_error", message: "Could not process delivery." } },
      { status: 500, headers: noStore },
    );
  }
}
