import "server-only";
import { and, eq, gte, inArray, lt, lte, or, sql } from "drizzle-orm";
import type { Db } from "../db";
import { jobs, type Job } from "../db/schema";

/**
 * A claimed job is leased for this long. It must comfortably exceed one job's processing
 * time (a few GitHub/Slack calls with 10s timeouts each). If the worker dies, the lease
 * expires and another worker claims the job again.
 */
export const LEASE_SECONDS = 120;
const MAX_ERROR_LENGTH = 1_000;

export type ClaimedJob = Job;

const truncate = (s: string) => (s.length > MAX_ERROR_LENGTH ? `${s.slice(0, MAX_ERROR_LENGTH)}…` : s);

/**
 * Atomically claims up to `limit` due jobs: pending jobs whose run_at has passed, and
 * running jobs whose lease expired (their worker crashed or timed out). `SKIP LOCKED`
 * lets concurrent workers claim disjoint sets without blocking each other. The attempt
 * counter is incremented at claim time, so a job that keeps crashing its worker still
 * runs out of attempts.
 */
export async function claimDueJobs(db: Db, limit = 5): Promise<ClaimedJob[]> {
  const due = db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        lt(jobs.attempts, jobs.maxAttempts),
        or(
          and(eq(jobs.status, "pending"), lte(jobs.runAt, sql`now()`)),
          and(eq(jobs.status, "running"), lt(jobs.lockedUntil, sql`now()`)),
        ),
      ),
    )
    .orderBy(jobs.runAt)
    .limit(limit)
    .for("update", { skipLocked: true });

  return db
    .update(jobs)
    .set({
      status: "running",
      attempts: sql`${jobs.attempts} + 1`,
      lockedUntil: sql`now() + (${LEASE_SECONDS}::int * interval '1 second')`,
      updatedAt: sql`now()`,
    })
    .where(inArray(jobs.id, due))
    .returning();
}

/**
 * Fencing: only the worker that holds the current claim may finish a job. Every claim
 * increments `attempts`, so (id, status = running, attempts) identifies one claim; a
 * worker whose lease expired and was re-claimed updates zero rows instead of
 * overwriting the new owner's state.
 */
function ownedBy(job: ClaimedJob) {
  return and(eq(jobs.id, job.id), eq(jobs.status, "running"), eq(jobs.attempts, job.attempts));
}

export async function completeJob(db: Db, job: ClaimedJob): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({
      status: "succeeded",
      lockedUntil: null,
      lastError: null,
      completedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(ownedBy(job))
    .returning({ id: jobs.id });
  return rows.length === 1;
}

export async function rescheduleJob(
  db: Db,
  job: ClaimedJob,
  delaySeconds: number,
  error: string,
): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({
      status: "pending",
      lockedUntil: null,
      lastError: truncate(error),
      runAt: sql`now() + (${Math.max(1, Math.round(delaySeconds))}::int * interval '1 second')`,
      updatedAt: sql`now()`,
    })
    .where(ownedBy(job))
    .returning({ id: jobs.id });
  return rows.length === 1;
}

export async function failJob(db: Db, job: ClaimedJob, error: string): Promise<boolean> {
  const rows = await db
    .update(jobs)
    .set({
      status: "failed",
      lockedUntil: null,
      lastError: truncate(error),
      completedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(ownedBy(job))
    .returning({ id: jobs.id });
  return rows.length === 1;
}

/**
 * Jobs whose worker died during their final attempt can never be claimed again (no
 * attempts left), so they are marked failed here instead of staying "running" forever.
 */
export async function reapAbandonedJobs(db: Db): Promise<Array<{ id: string; webhookEventId: string }>> {
  return db
    .update(jobs)
    .set({
      status: "failed",
      lockedUntil: null,
      completedAt: sql`now()`,
      updatedAt: sql`now()`,
      lastError: sql`coalesce(${jobs.lastError} || ' — ', '') || 'worker stopped during the final attempt (lease expired)'`,
    })
    .where(
      and(eq(jobs.status, "running"), lt(jobs.lockedUntil, sql`now()`), gte(jobs.attempts, jobs.maxAttempts)),
    )
    .returning({ id: jobs.id, webhookEventId: jobs.webhookEventId });
}

/** Seconds until the earliest of these pending jobs is due (null if none is pending). */
export async function secondsUntilDue(db: Db, jobIds: string[]): Promise<number | null> {
  if (jobIds.length === 0) return null;
  const [row] = await db
    .select({ wait: sql<string | null>`extract(epoch from (min(${jobs.runAt}) - now()))` })
    .from(jobs)
    .where(and(inArray(jobs.id, jobIds), eq(jobs.status, "pending")));
  if (!row || row.wait === null) return null;
  return Math.max(0, Number(row.wait));
}
