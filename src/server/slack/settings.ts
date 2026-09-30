import "server-only";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto";
import type { Db } from "../db";
import { users } from "../db/schema";
import type { Env } from "../env";

export type SlackSource = "user" | "default" | "none";

export type ResolvedSlackWebhook =
  { url: string; source: "user" | "default" } | { url: null; source: "none"; reason: string };

/**
 * Where a user's notifications go: their own webhook (Settings) if saved, otherwise the
 * deployment default (SLACK_WEBHOOK_URL), otherwise nowhere. A saved URL that no longer
 * decrypts (encryption key changed) is reported, not silently replaced by the default.
 */
export async function resolveSlackWebhook(db: Db, env: Env, userId: string): Promise<ResolvedSlackWebhook> {
  const [row] = await db
    .select({ enc: users.slackWebhookUrlEnc })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (row?.enc) {
    try {
      return { url: decryptSecret(row.enc, env.TOKEN_ENCRYPTION_KEY), source: "user" };
    } catch {
      return {
        url: null,
        source: "none",
        reason: "The saved Slack webhook could not be read. Save it again in Settings.",
      };
    }
  }
  if (env.SLACK_WEBHOOK_URL) return { url: env.SLACK_WEBHOOK_URL, source: "default" };
  return { url: null, source: "none", reason: "No Slack webhook is configured (Settings → Slack)." };
}

export async function slackStatus(db: Db, env: Env, userId: string) {
  const resolved = await resolveSlackWebhook(db, env, userId);
  return {
    source: resolved.source as SlackSource,
    defaultAvailable: Boolean(env.SLACK_WEBHOOK_URL),
    problem: resolved.url === null && resolved.reason.startsWith("The saved") ? resolved.reason : null,
  };
}

/** Stores the URL encrypted. It is a secret (Slack revokes leaked ones) and is never returned. */
export async function saveUserSlackWebhook(db: Db, env: Env, userId: string, url: string): Promise<void> {
  await db
    .update(users)
    .set({ slackWebhookUrlEnc: encryptSecret(url, env.TOKEN_ENCRYPTION_KEY), updatedAt: new Date() })
    .where(eq(users.id, userId));
}

export async function clearUserSlackWebhook(db: Db, userId: string): Promise<void> {
  await db.update(users).set({ slackWebhookUrlEnc: null, updatedAt: new Date() }).where(eq(users.id, userId));
}
