import "server-only";
import {
  abandonEvent,
  processEvent,
  type ProcessInput,
  type ProcessOutcome,
} from "../automation/process-event";
import { describeError } from "../automation/errors";
import { productionExecutors } from "../automation/executors";
import type { Db } from "../db";
import type { Env } from "../env";
import { logger } from "../logger";
import { retryDelaySeconds } from "./backoff";
import {
  claimDueJobs,
  completeJob,
  failJob,
  reapAbandonedJobs,
  rescheduleJob,
  secondsUntilDue,
} from "./queue";

export type Processor = (input: ProcessInput) => Promise<ProcessOutcome>;

export type DrainOptions = {
  /** Stop claiming new jobs once this much time has passed. */
  budgetMs: number;
  batchSize?: number;
  /**
   * If a job this call rescheduled becomes due within the remaining budget, wait for it
   * instead of leaving it to the next sweep. Used right after a webhook, so a transient
   * GitHub/Slack error is retried within seconds rather than minutes.
   */
  waitForRetries?: boolean;
  processor?: Processor;
  backoff?: (attempt: number) => number;
};

export type DrainStats = {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
  reaped: number;
};

const SAFETY_MARGIN_MS = 5_000;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Drains due jobs until the time budget is used up. Every trigger (after() in the
 * webhook route, the cron sweeper, a manual retry) calls this; correctness never depends
 * on which one runs, because all state lives in Postgres.
 */
export async function drainJobs(db: Db, env: Env, opts: DrainOptions): Promise<DrainStats> {
  const processor: Processor =
    opts.processor ?? ((input) => processEvent(db, env, input, productionExecutors));
  const backoff = opts.backoff ?? retryDelaySeconds;
  const deadline = Date.now() + opts.budgetMs;
  const stats: DrainStats = { claimed: 0, succeeded: 0, retried: 0, failed: 0, reaped: 0 };

  for (const job of await reapAbandonedJobs(db)) {
    stats.reaped++;
    await abandonEvent(
      db,
      job.webhookEventId,
      "Processing stopped during the final attempt (worker timed out).",
    );
    logger.error("job_failed_permanently", {
      jobId: job.id,
      eventId: job.webhookEventId,
      reason: "lease_expired",
    });
  }

  const rescheduledHere = new Set<string>();
  while (Date.now() < deadline - SAFETY_MARGIN_MS) {
    const claimed = await claimDueJobs(db, opts.batchSize ?? 5);

    if (claimed.length === 0) {
      if (!opts.waitForRetries) break;
      const wait = await secondsUntilDue(db, [...rescheduledHere]);
      if (wait === null) break;
      const waitMs = Math.max(wait * 1000, 200);
      if (Date.now() + waitMs > deadline - SAFETY_MARGIN_MS) break;
      await sleep(waitMs);
      continue;
    }

    for (const job of claimed) {
      stats.claimed++;
      const isFinalAttempt = job.attempts >= job.maxAttempts;
      logger.info("job_started", {
        jobId: job.id,
        eventId: job.webhookEventId,
        attempt: job.attempts,
        maxAttempts: job.maxAttempts,
      });

      const startedAt = Date.now();
      const logJob = { jobId: job.id, eventId: job.webhookEventId, attempt: job.attempts };
      let outcome: ProcessOutcome;
      try {
        outcome = await processor({
          webhookEventId: job.webhookEventId,
          attempt: job.attempts,
          isFinalAttempt,
        });
      } catch (err) {
        outcome = { kind: "retry", error: describeError(err) };
        logger.error("job_crashed", { ...logJob, error: outcome.error });
      }

      if (outcome.kind === "done") {
        rescheduledHere.delete(job.id);
        if (await completeJob(db, job)) {
          stats.succeeded++;
          logger.info("job_succeeded", { ...logJob, durationMs: Date.now() - startedAt });
        } else {
          logger.warn("job_lease_lost", logJob);
        }
      } else if (isFinalAttempt) {
        rescheduledHere.delete(job.id);
        if (await failJob(db, job, outcome.error)) {
          await abandonEvent(
            db,
            job.webhookEventId,
            `Gave up after ${job.attempts} attempts: ${outcome.error}`,
          );
          stats.failed++;
          logger.error("job_failed_permanently", {
            ...logJob,
            error: outcome.error,
            durationMs: Date.now() - startedAt,
          });
        } else {
          logger.warn("job_lease_lost", logJob);
        }
      } else {
        const delay = backoff(job.attempts);
        if (await rescheduleJob(db, job, delay, outcome.error)) {
          rescheduledHere.add(job.id);
          stats.retried++;
          logger.warn("job_retry_scheduled", {
            ...logJob,
            delaySeconds: delay,
            error: outcome.error,
            durationMs: Date.now() - startedAt,
          });
        } else {
          logger.warn("job_lease_lost", logJob);
        }
      }
    }
  }
  return stats;
}
