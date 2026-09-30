import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { isSlackWebhookUrl } from "@/lib/slack-url";
import type { AuthDeps } from "../auth/handlers";
import { parseJsonBody, withUser } from "../http/api";
import { AppError, jsonError } from "../http/errors";
import { logger } from "../logger";
import { consumeRateLimit } from "../rate-limit";
import { postSlackMessage, SlackError } from "./client";
import { buildTestNotification } from "./message";
import { clearUserSlackWebhook, resolveSlackWebhook, saveUserSlackWebhook, slackStatus } from "./settings";

type Deps = AuthDeps | (() => AuthDeps);
const noStore = { "Cache-Control": "no-store" };

const saveSchema = z.strictObject({
  webhookUrl: z
    .string()
    .trim()
    .refine(isSlackWebhookUrl, "Enter a Slack Incoming Webhook URL (https://hooks.slack.com/services/…)."),
});

/** GET /api/settings/slack — where notifications go. Never includes the URL itself. */
export function getSlackSettingsHandler(request: NextRequest, deps: Deps) {
  return withUser(request, deps, "slack_settings_get", async (user, { db, env }) =>
    NextResponse.json(await slackStatus(db, env, user.id), { headers: noStore }),
  );
}

/** PUT /api/settings/slack { webhookUrl } */
export function saveSlackSettingsHandler(request: NextRequest, deps: Deps) {
  return withUser(request, deps, "slack_settings_save", async (user, { db, env }) => {
    const { webhookUrl } = await parseJsonBody(request, saveSchema);
    await saveUserSlackWebhook(db, env, user.id, webhookUrl);
    logger.info("slack_webhook_saved", { userId: user.id });
    return NextResponse.json(await slackStatus(db, env, user.id), { headers: noStore });
  });
}

/** DELETE /api/settings/slack — fall back to the deployment default (if any). */
export function clearSlackSettingsHandler(request: NextRequest, deps: Deps) {
  return withUser(request, deps, "slack_settings_clear", async (user, { db, env }) => {
    await clearUserSlackWebhook(db, user.id);
    logger.info("slack_webhook_cleared", { userId: user.id });
    return NextResponse.json(await slackStatus(db, env, user.id), { headers: noStore });
  });
}

/** POST /api/settings/slack/test — sends a real test message to the effective webhook. */
export function testSlackHandler(request: NextRequest, deps: Deps) {
  return withUser(request, deps, "slack_settings_test", async (user, { db, env }) => {
    // Slack allows ~1 message/second per webhook; keep manual tests well below that.
    const rl = await consumeRateLimit(db, `slack_test:${user.id}`, 5, 60);
    if (!rl.allowed) {
      return jsonError(429, "rate_limited", "Too many test messages. Try again in a minute.", {
        "Retry-After": String(rl.retryAfterSeconds),
      });
    }
    const target = await resolveSlackWebhook(db, env, user.id);
    if (target.url === null) throw new AppError(409, "slack_not_configured", target.reason);
    try {
      await postSlackMessage(target.url, buildTestNotification(user.githubLogin));
    } catch (err) {
      if (err instanceof SlackError) {
        logger.warn("slack_test_failed", { userId: user.id, status: err.status, error: err.message });
        throw new AppError(err.retryable ? 502 : 422, "slack_delivery_failed", err.message, { cause: err });
      }
      throw err;
    }
    logger.info("slack_test_sent", { userId: user.id, source: target.source });
    return NextResponse.json({ ok: true, source: target.source }, { headers: noStore });
  });
}
