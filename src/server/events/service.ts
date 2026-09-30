import "server-only";
import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { automationRuns, webhookEvents } from "../db/schema";

export type EventSummaryDTO = {
  id: string;
  eventType: string;
  action: string | null;
  repoFullName: string | null;
  senderLogin: string | null;
  subject: { kind: string; number: number; title: string; url: string } | null;
  status: string;
  ignoreReason: string | null;
  /** How many rules matched (automation runs created) — 0 explains a "processed" event with no effect. */
  runCount: number;
  receivedAt: string;
};

/** Most recent deliveries for the user's repositories. Always scoped by user id. */
export async function listRecentEvents(db: Db, userId: string, limit = 20): Promise<EventSummaryDTO[]> {
  const rows = await db
    .select({
      id: webhookEvents.id,
      eventType: webhookEvents.eventType,
      action: webhookEvents.action,
      repoFullName: webhookEvents.repoFullName,
      senderLogin: webhookEvents.senderLogin,
      subject: webhookEvents.subject,
      status: webhookEvents.status,
      ignoreReason: webhookEvents.ignoreReason,
      // Correlated subquery with explicit table qualification: in a single-table select
      // Drizzle renders columns unqualified, so "id" would bind to automation_runs.id.
      runCount: sql<number>`(select count(*)::int from ${automationRuns} where ${automationRuns}.webhook_event_id = ${webhookEvents}.id)`,
      receivedAt: webhookEvents.receivedAt,
    })
    .from(webhookEvents)
    .where(eq(webhookEvents.userId, userId))
    .orderBy(desc(webhookEvents.receivedAt))
    .limit(Math.min(Math.max(limit, 1), 100));
  return rows.map((r) => ({
    ...r,
    subject: r.subject
      ? { kind: r.subject.kind, number: r.subject.number, title: r.subject.title, url: r.subject.url }
      : null,
    runCount: Number(r.runCount),
    receivedAt: r.receivedAt.toISOString(),
  }));
}
