import "server-only";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db";
import { rules, type EventSubject, type Rule, type WebhookEvent } from "../db/schema";

export type MatchableEvent = Pick<WebhookEvent, "eventType" | "action"> & { subject: EventSubject | null };
type MatchableRule = Pick<Rule, "enabled" | "eventType" | "eventActions" | "keywords" | "keywordScope">;

/**
 * Pure rule evaluation. A rule matches when it is enabled, targets this event type and
 * action, and — if it has keywords — ANY keyword occurs (case-insensitive substring) in
 * the title, or in title + body for `title_and_body`. No keywords = match every event
 * of that type/action.
 */
export function ruleMatchesEvent(rule: MatchableRule, event: MatchableEvent): boolean {
  if (!rule.enabled || rule.eventType !== event.eventType) return false;
  if (!event.action || !rule.eventActions.includes(event.action)) return false;
  if (!event.subject) return false;
  const keywords = rule.keywords.map((k) => k.trim().toLowerCase()).filter(Boolean);
  if (keywords.length === 0) return true;
  const text = (
    rule.keywordScope === "title_and_body"
      ? `${event.subject.title}\n${event.subject.body}`
      : event.subject.title
  ).toLowerCase();
  return keywords.some((k) => text.includes(k));
}

/** Enabled rules of the event's repository (and owner) that match it. */
export async function findMatchingRules(db: Db, event: WebhookEvent): Promise<Rule[]> {
  if (!event.repositoryId || !event.userId) return [];
  const candidates = await db
    .select()
    .from(rules)
    .where(
      and(
        eq(rules.repositoryId, event.repositoryId),
        eq(rules.userId, event.userId),
        eq(rules.enabled, true),
      ),
    );
  return candidates.filter((r) => ruleMatchesEvent(r, event));
}
