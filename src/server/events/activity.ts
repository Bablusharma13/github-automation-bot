import "server-only";
import { and, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { EventDetailDTO, EventDTO, EventFilter, JobDTO, RunDTO, StatsDTO } from "@/lib/activity-types";
import type { Db } from "../db";
import {
  automationRuns,
  jobs,
  repositories,
  rules,
  webhookEvents,
  type AutomationRun,
  type Job,
  type WebhookEvent,
} from "../db/schema";
import { AppError } from "../http/errors";

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toRunDTO(r: AutomationRun): RunDTO {
  return {
    id: r.id,
    ruleId: r.ruleId,
    ruleName: r.ruleName,
    actionType: r.actionType,
    actionValue: r.actionValue,
    status: r.status,
    githubStatus: r.githubStatus,
    githubAttempts: r.githubAttempts,
    githubResult: r.githubResult ?? null,
    githubError: r.githubError,
    slackStatus: r.slackStatus,
    slackAttempts: r.slackAttempts,
    slackError: r.slackError,
    startedAt: iso(r.startedAt),
    completedAt: iso(r.completedAt),
    createdAt: r.createdAt.toISOString(),
  };
}

function toJobDTO(j: Job): JobDTO {
  return {
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    runAt: j.runAt.toISOString(),
    lastError: j.lastError,
    completedAt: iso(j.completedAt),
  };
}

function toEventDTO(e: WebhookEvent, job: Job | undefined, runs: AutomationRun[]): EventDTO {
  return {
    id: e.id,
    deliveryId: e.deliveryId,
    eventType: e.eventType,
    action: e.action,
    repoFullName: e.repoFullName,
    senderLogin: e.senderLogin,
    subject: e.subject
      ? {
          kind: e.subject.kind,
          number: e.subject.number,
          title: e.subject.title,
          url: e.subject.url,
          author: e.subject.author,
          labels: e.subject.labels,
        }
      : null,
    status: e.status,
    ignoreReason: e.ignoreReason,
    errorMessage: e.errorMessage,
    receivedAt: e.receivedAt.toISOString(),
    processedAt: iso(e.processedAt),
    job: job ? toJobDTO(job) : null,
    runs: runs.map(toRunDTO),
    ai: e.aiStatus
      ? {
          status: e.aiStatus,
          result: e.aiStatus === "succeeded" ? (e.aiResult ?? null) : null,
          model: e.aiModel,
          error: e.aiError,
          completedAt: iso(e.aiCompletedAt),
        }
      : null,
  };
}

/** Attaches jobs and runs to events with two extra queries (no N+1). */
async function hydrate(db: Db, events: WebhookEvent[]): Promise<EventDTO[]> {
  if (events.length === 0) return [];
  const ids = events.map((e) => e.id);
  const [jobRows, runRows] = await Promise.all([
    db.select().from(jobs).where(inArray(jobs.webhookEventId, ids)),
    db
      .select()
      .from(automationRuns)
      .where(inArray(automationRuns.webhookEventId, ids))
      .orderBy(automationRuns.createdAt),
  ]);
  const jobByEvent = new Map(jobRows.map((j) => [j.webhookEventId, j]));
  const runsByEvent = new Map<string, AutomationRun[]>();
  for (const r of runRows)
    runsByEvent.set(r.webhookEventId, [...(runsByEvent.get(r.webhookEventId) ?? []), r]);
  return events.map((e) => toEventDTO(e, jobByEvent.get(e.id), runsByEvent.get(e.id) ?? []));
}

// Qualified explicitly: in single-table selects Drizzle renders columns unqualified,
// which would bind these names to the subquery's own table.
const hasFailedRun = sql`exists (select 1 from ${automationRuns} where ${automationRuns}.webhook_event_id = ${webhookEvents}.id and ${automationRuns}.status = 'failed')`;

/**
 * The caller's activity, newest first. `before` is an ISO timestamp cursor (the last
 * receivedAt of the previous page). Always scoped by user id.
 */
export async function listEvents(
  db: Db,
  userId: string,
  opts: { limit?: number; before?: string; filter?: EventFilter } = {},
): Promise<{ events: EventDTO[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const filter =
    opts.filter === "failed"
      ? or(eq(webhookEvents.status, "failed"), hasFailedRun)
      : opts.filter === "in_progress"
        ? inArray(webhookEvents.status, ["received", "processing"])
        : undefined;
  const rows = await db
    .select()
    .from(webhookEvents)
    .where(
      and(
        eq(webhookEvents.userId, userId),
        opts.before ? lt(webhookEvents.receivedAt, new Date(opts.before)) : undefined,
        filter,
      ),
    )
    .orderBy(desc(webhookEvents.receivedAt))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    events: await hydrate(db, page),
    nextCursor: rows.length > limit ? page[page.length - 1]!.receivedAt.toISOString() : null,
  };
}

export async function getEventDetail(db: Db, userId: string, id: string): Promise<EventDetailDTO> {
  const [event] = await db
    .select()
    .from(webhookEvents)
    .where(and(eq(webhookEvents.id, id), eq(webhookEvents.userId, userId)))
    .limit(1);
  // Someone else's event is indistinguishable from a missing one.
  if (!event) throw new AppError(404, "not_found", "Event not found.");
  const [dto] = await hydrate(db, [event]);
  return { ...dto!, bodyPreview: (event.subject?.body ?? "").slice(0, 500) };
}

export async function getStats(db: Db, userId: string): Promise<StatsDTO> {
  const count = sql<number>`count(*)::int`;
  const [[repos], [enabledRules], [events], [runs], [retries]] = await Promise.all([
    db
      .select({ n: count })
      .from(repositories)
      .where(and(eq(repositories.userId, userId), eq(repositories.active, true))),
    db
      .select({ n: count })
      .from(rules)
      .where(and(eq(rules.userId, userId), eq(rules.enabled, true))),
    db
      .select({
        total: count,
        last24h: sql<number>`count(*) filter (where ${webhookEvents.receivedAt} > now() - interval '24 hours')::int`,
      })
      .from(webhookEvents)
      .where(eq(webhookEvents.userId, userId)),
    db
      .select({
        succeeded: sql<number>`count(*) filter (where ${automationRuns.githubStatus} = 'succeeded')::int`,
        failed: sql<number>`count(*) filter (where ${automationRuns.status} = 'failed')::int`,
      })
      .from(automationRuns)
      .where(eq(automationRuns.userId, userId)),
    db
      .select({ n: count })
      .from(jobs)
      .innerJoin(webhookEvents, eq(jobs.webhookEventId, webhookEvents.id))
      .where(and(eq(webhookEvents.userId, userId), eq(jobs.status, "pending"), sql`${jobs.attempts} > 0`)),
  ]);
  return {
    connectedRepositories: Number(repos?.n ?? 0),
    enabledRules: Number(enabledRules?.n ?? 0),
    events24h: Number(events?.last24h ?? 0),
    eventsTotal: Number(events?.total ?? 0),
    actionsSucceeded: Number(runs?.succeeded ?? 0),
    actionsFailed: Number(runs?.failed ?? 0),
    retriesPending: Number(retries?.n ?? 0),
  };
}
