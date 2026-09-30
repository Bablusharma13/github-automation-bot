import "server-only";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { jobs, repositories, webhookEvents, type EventSubject } from "../db/schema";
import type { Env } from "../env";
import { logger, serializeError } from "../logger";
import { envelopeSchema, extractSubject, isSupportedEvent } from "./payloads";
import { verifySignature } from "./signature";

/**
 * GitHub caps payloads at 25 MB, but issue / pull request payloads are far smaller
 * (bodies are limited to 65,536 characters) and Vercel limits request bodies to 4.5 MB.
 * A tight cap keeps unauthenticated requests from making us buffer large bodies.
 */
export const MAX_WEBHOOK_BODY_BYTES = 2 * 1024 * 1024;

const DELIVERY_ID = /^[A-Za-z0-9-]{1,100}$/;
const EVENT_NAME = /^[a-z_]{1,64}$/;

export type IngestResult =
  | { status: 202; body: { ok: true; status: "queued" }; eventId: string }
  | { status: 200; body: { ok: true; status: "duplicate" } }
  | { status: 200; body: { ok: true; status: "ignored"; reason: IgnoreReason }; eventId: string }
  | { status: 400 | 401 | 413 | 415 | 500; body: { error: { code: string; message: string } } };

export type IgnoreReason = "ping" | "unsupported_event" | "repository_not_connected" | "unknown_hook";

function reject(
  status: 400 | 401 | 413 | 415 | 500,
  code: string,
  message: string,
  logFields: Record<string, unknown> = {},
): IngestResult {
  logger.warn("github_webhook_rejected", { reason: code, ...logFields });
  return { status, body: { error: { code, message } } };
}

type DeliveryInput = {
  headers: Headers;
  /** Raw request bytes — the signature is computed over exactly these. */
  rawBody: Buffer;
};

/**
 * Verifies, validates and durably records one GitHub webhook delivery.
 *
 * Order matters: size → signature → headers → content type → payload. Nothing is
 * parsed or stored before the signature checks out, so forged requests never reach
 * the database. For deliveries we act on, the event row and its processing job are
 * written in ONE transaction (transactional outbox): if we answer 2xx, the work is
 * guaranteed to exist. Duplicate deliveries are detected by the database via
 * UNIQUE(delivery_id) + ON CONFLICT DO NOTHING, which also settles concurrent races.
 */
export async function ingestGitHubDelivery(db: Db, env: Env, input: DeliveryInput): Promise<IngestResult> {
  const { headers, rawBody } = input;
  if (rawBody.byteLength > MAX_WEBHOOK_BODY_BYTES) {
    return reject(413, "payload_too_large", "Payload too large.", { bytes: rawBody.byteLength });
  }

  const signature = headers.get("x-hub-signature-256");
  if (!signature) return reject(401, "missing_signature", "Missing X-Hub-Signature-256 header.");
  if (!verifySignature(env.GITHUB_WEBHOOK_SECRET, rawBody, signature)) {
    return reject(401, "invalid_signature", "Signature verification failed.");
  }

  // Authenticated from here on: the sender knows our webhook secret (i.e. it is GitHub).
  const deliveryId = headers.get("x-github-delivery");
  const event = headers.get("x-github-event");
  if (!deliveryId || !DELIVERY_ID.test(deliveryId)) {
    return reject(400, "invalid_delivery_id", "Missing or invalid X-GitHub-Delivery header.");
  }
  if (!event || !EVENT_NAME.test(event)) {
    return reject(400, "invalid_event", "Missing or invalid X-GitHub-Event header.", { deliveryId });
  }
  const contentType = headers.get("content-type") ?? "";
  if (!/^application\/json\b/i.test(contentType)) {
    return reject(415, "unsupported_content_type", "Webhook content type must be application/json.", {
      deliveryId,
    });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return reject(400, "malformed_payload", "Payload is not valid JSON.", { deliveryId, event });
  }
  const envelope = envelopeSchema.safeParse(payload);
  if (!envelope.success) {
    return reject(400, "malformed_payload", "Payload does not have the expected shape.", {
      deliveryId,
      event,
    });
  }
  const { action, repository, sender } = envelope.data;

  let subject: EventSubject | null = null;
  if (isSupportedEvent(event)) {
    subject = extractSubject(event, payload);
    if (!subject) {
      return reject(400, "malformed_payload", `Payload is missing required ${event} fields.`, {
        deliveryId,
        event,
      });
    }
  }

  logger.info("github_webhook_received", {
    deliveryId,
    eventType: event,
    action,
    repository: repository?.full_name,
  });

  try {
    // Which connected repository (and therefore which user) this delivery belongs to.
    const [repo] = repository
      ? await db
          .select({ id: repositories.id, userId: repositories.userId, webhookId: repositories.webhookId })
          .from(repositories)
          .where(and(eq(repositories.githubRepoId, repository.id), eq(repositories.active, true)))
          .limit(1)
      : [];

    const hookHeader = headers.get("x-github-hook-id");
    const hookId = hookHeader && /^\d+$/.test(hookHeader) ? Number(hookHeader) : null;

    let ignoreReason: IgnoreReason | null = null;
    if (event === "ping") ignoreReason = "ping";
    else if (!isSupportedEvent(event)) ignoreReason = "unsupported_event";
    else if (!repo) ignoreReason = "repository_not_connected";
    // Only the hook we installed may trigger automation. A second hook with our URL
    // (e.g. added by hand) would otherwise deliver every event twice under different
    // delivery ids and run each rule twice.
    else if (repo.webhookId !== null && hookId !== null && hookId !== repo.webhookId) {
      ignoreReason = "unknown_hook";
    }

    const result = await db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(webhookEvents)
        .values({
          deliveryId,
          eventType: event,
          action: action ?? null,
          userId: repo?.userId ?? null,
          repositoryId: repo?.id ?? null,
          githubRepoId: repository?.id ?? null,
          repoFullName: repository?.full_name ?? null,
          senderLogin: sender?.login ?? null,
          // Content of repositories nobody connected is not kept.
          subject: repo ? subject : null,
          status: ignoreReason ? "ignored" : "received",
          ignoreReason,
          processedAt: ignoreReason ? new Date() : null,
        })
        .onConflictDoNothing({ target: webhookEvents.deliveryId })
        .returning({ id: webhookEvents.id });
      if (!inserted) return { duplicate: true as const };

      if (!ignoreReason) await tx.insert(jobs).values({ webhookEventId: inserted.id });
      return { duplicate: false as const, eventId: inserted.id };
    });

    if (result.duplicate) {
      logger.info("github_webhook_duplicate", { deliveryId, eventType: event });
      return { status: 200, body: { ok: true, status: "duplicate" } };
    }
    if (ignoreReason) {
      logger.info("github_webhook_ignored", { deliveryId, eventType: event, reason: ignoreReason });
      return {
        status: 200,
        body: { ok: true, status: "ignored", reason: ignoreReason },
        eventId: result.eventId,
      };
    }
    logger.info("job_created", { deliveryId, eventId: result.eventId, eventType: event, action });
    return { status: 202, body: { ok: true, status: "queued" }, eventId: result.eventId };
  } catch (err) {
    // Never acknowledge a delivery we failed to store: a non-2xx lets it be redelivered.
    logger.error("github_webhook_persist_failed", {
      deliveryId,
      eventType: event,
      error: serializeError(err),
    });
    return {
      status: 500,
      body: { error: { code: "internal_error", message: "Could not record delivery." } },
    };
  }
}
