import "server-only";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db";
import { automationRuns, jobs, webhookEvents } from "../db/schema";
import { AppError } from "../http/errors";
import { logger } from "../logger";

/**
 * Manual retry of an event whose processing failed or that has failed steps.
 *
 * - Only failed steps are reset to pending; succeeded steps are never re-run (a GitHub
 *   label/comment that worked is not repeated).
 * - If the GitHub step is retried, the Slack step is reset too (unless the rule had
 *   notifications turned off), so Slack reports the new outcome.
 * - A failed AI triage is cleared so it runs again (it never blocks the other steps).
 * - The job gets a fresh attempt budget and is due immediately; the caller then drains it.
 * - Refused while the event is being processed (valid lease), so a manual retry cannot
 *   race a running worker.
 */
export async function retryEvent(db: Db, userId: string, eventId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [event] = await tx
      .select()
      .from(webhookEvents)
      .where(and(eq(webhookEvents.id, eventId), eq(webhookEvents.userId, userId)))
      .for("update")
      .limit(1);
    if (!event) throw new AppError(404, "not_found", "Event not found.");

    const [job] = await tx.select().from(jobs).where(eq(jobs.webhookEventId, eventId)).for("update").limit(1);
    if (job?.status === "running" && job.lockedUntil && job.lockedUntil.getTime() > Date.now()) {
      throw new AppError(409, "in_progress", "This event is being processed right now.");
    }

    const failedRuns = await tx
      .select({ id: automationRuns.id })
      .from(automationRuns)
      .where(and(eq(automationRuns.webhookEventId, eventId), eq(automationRuns.status, "failed")));
    if (event.status !== "failed" && failedRuns.length === 0 && event.aiStatus !== "failed") {
      throw new AppError(409, "nothing_to_retry", "Nothing to retry: this event has no failed steps.");
    }

    if (failedRuns.length > 0) {
      // SET expressions see the row's values from before the update.
      await tx
        .update(automationRuns)
        .set({
          status: "running",
          completedAt: null,
          updatedAt: new Date(),
          githubStatus: sql`case when ${automationRuns.githubStatus} = 'failed' then 'pending'::step_status else ${automationRuns.githubStatus} end`,
          slackStatus: sql`case
            when ${automationRuns.slackStatus} = 'failed' then 'pending'::step_status
            when ${automationRuns.githubStatus} = 'failed'
              and (${automationRuns.slackStatus} = 'succeeded'
                   or (${automationRuns.slackStatus} = 'skipped' and ${automationRuns.slackError} is not null))
              then 'pending'::step_status
            else ${automationRuns.slackStatus} end`,
        })
        .where(and(eq(automationRuns.webhookEventId, eventId), eq(automationRuns.status, "failed")));
    }

    await tx
      .update(webhookEvents)
      .set({
        status: "processing",
        errorMessage: null,
        processedAt: null,
        ...(event.aiStatus === "failed" ? { aiStatus: null, aiError: null, aiCompletedAt: null } : {}),
      })
      .where(eq(webhookEvents.id, eventId));

    if (job) {
      await tx
        .update(jobs)
        .set({
          status: "pending",
          attempts: 0,
          runAt: sql`now()`,
          lockedUntil: null,
          lastError: null,
          completedAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(jobs.id, job.id));
    } else {
      await tx.insert(jobs).values({ webhookEventId: eventId });
    }
  });
  logger.info("event_retry_requested", { userId, eventId });
}
