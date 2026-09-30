import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db";
import {
  automationRuns,
  repositories,
  webhookEvents,
  type AutomationRun,
  type Rule,
  type WebhookEvent,
} from "../db/schema";
import type { Env } from "../env";
import { logger } from "../logger";
import { findMatchingRules } from "../rules/match";
import { describeError, isRetryable } from "./errors";
import type { Executors, StepContext } from "./executors";

export type ProcessInput = { webhookEventId: string; attempt: number; isFinalAttempt: boolean };
export type ProcessOutcome = { kind: "done" } | { kind: "retry"; error: string };
export type RuleMatcher = (db: Db, event: WebhookEvent) => Promise<Rule[]>;

async function updateRun(db: Db, id: string, values: Partial<typeof automationRuns.$inferInsert>) {
  const [row] = await db
    .update(automationRuns)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(automationRuns.id, id))
    .returning();
  return row!;
}

/**
 * Processes one webhook event. Safe to call any number of times for the same event:
 *
 * - Runs are UNIQUE per (event, rule) and inserted with ON CONFLICT DO NOTHING, so a
 *   retried job reuses its runs instead of creating new ones.
 * - Each run has two steps with their own persisted status — GitHub write-back, then the
 *   Slack notification. A step that succeeded is never executed again, so a Slack failure
 *   cannot repeat (or undo) the GitHub action.
 * - Slack waits until the GitHub step is terminal, so the notification reports the real
 *   outcome, including failures.
 * - Transient failures → { kind: "retry" } (the worker reschedules with backoff). On the
 *   final attempt they are recorded as permanent failures instead.
 */
export async function processEvent(
  db: Db,
  env: Env,
  input: ProcessInput,
  executors: Executors,
  matchRules: RuleMatcher = findMatchingRules,
): Promise<ProcessOutcome> {
  const [event] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.id, input.webhookEventId))
    .limit(1);
  if (!event || event.status === "processed" || event.status === "ignored") return { kind: "done" };

  const [repository] = event.repositoryId
    ? await db.select().from(repositories).where(eq(repositories.id, event.repositoryId)).limit(1)
    : [];
  if (!repository || !repository.active || !event.subject || !event.userId) {
    await db
      .update(webhookEvents)
      .set({ status: "ignored", ignoreReason: "repository_disconnected", processedAt: new Date() })
      .where(eq(webhookEvents.id, event.id));
    logger.info("event_ignored_at_processing", { eventId: event.id, reason: "repository_disconnected" });
    return { kind: "done" };
  }
  if (event.status !== "processing") {
    await db.update(webhookEvents).set({ status: "processing" }).where(eq(webhookEvents.id, event.id));
  }

  const matched = await matchRules(db, event);
  logger.info("rules_evaluated", { eventId: event.id, matched: matched.map((r) => r.id) });
  if (matched.length > 0) {
    await db
      .insert(automationRuns)
      .values(
        matched.map((rule) => ({
          webhookEventId: event.id,
          ruleId: rule.id,
          userId: event.userId!,
          repositoryId: repository.id,
          ruleName: rule.name,
          actionType: rule.actionType,
          actionValue: rule.actionValue,
          slackStatus: rule.notifySlack ? ("pending" as const) : ("skipped" as const),
        })),
      )
      .onConflictDoNothing({ target: [automationRuns.webhookEventId, automationRuns.ruleId] });
  }

  const runs = await db.select().from(automationRuns).where(eq(automationRuns.webhookEventId, event.id));
  let retryError: string | null = null;
  for (const run of runs) {
    const ctx: StepContext = { db, env, run, event, subject: event.subject, repository };
    const error = await advanceRun(ctx, executors, input);
    if (error && !retryError) retryError = error;
  }
  if (retryError) return { kind: "retry", error: retryError };

  await db
    .update(webhookEvents)
    .set({ status: "processed", processedAt: new Date(), errorMessage: null })
    .where(eq(webhookEvents.id, event.id));
  return { kind: "done" };
}

/** Advances one run as far as possible. Returns an error message if it needs a retry. */
async function advanceRun(
  ctx: StepContext,
  executors: Executors,
  input: ProcessInput,
): Promise<string | null> {
  const { db } = ctx;
  let run: AutomationRun = ctx.run;
  if (run.status === "succeeded" || run.status === "failed") return null;
  if (run.status === "pending") {
    run = await updateRun(db, run.id, { status: "running", startedAt: run.startedAt ?? new Date() });
  }
  const gaveUp = (message: string) => `${message} (gave up after ${input.attempt} attempts)`;

  if (run.githubStatus === "pending") {
    const attempts = run.githubAttempts + 1;
    try {
      const result = await executors.github({ ...ctx, run });
      run = await updateRun(db, run.id, {
        githubStatus: "succeeded",
        githubAttempts: attempts,
        githubResult: result,
        githubError: null,
      });
      logger.info("github_action_succeeded", { runId: run.id, action: run.actionType, result });
    } catch (err) {
      const message = describeError(err);
      const retry = isRetryable(err) && !input.isFinalAttempt;
      run = await updateRun(db, run.id, {
        githubAttempts: attempts,
        githubError: retry || !isRetryable(err) ? message : gaveUp(message),
        ...(retry ? {} : { githubStatus: "failed" as const }),
      });
      logger[retry ? "warn" : "error"]("github_action_failed", {
        runId: run.id,
        retryable: retry,
        error: message,
      });
      // Slack waits for a terminal GitHub outcome so the notification is truthful.
      if (retry) return message;
    }
  }

  if (run.slackStatus === "pending") {
    const attempts = run.slackAttempts + 1;
    try {
      const out = await executors.slack({ ...ctx, run });
      run = await updateRun(
        db,
        run.id,
        out.status === "sent"
          ? { slackStatus: "succeeded", slackAttempts: attempts, slackError: null }
          : { slackStatus: "skipped", slackAttempts: attempts, slackError: out.reason },
      );
      logger.info(out.status === "sent" ? "slack_notification_sent" : "slack_notification_skipped", {
        runId: run.id,
        ...(out.status === "skipped" ? { reason: out.reason } : {}),
      });
    } catch (err) {
      const message = describeError(err);
      const retry = isRetryable(err) && !input.isFinalAttempt;
      run = await updateRun(db, run.id, {
        slackAttempts: attempts,
        slackError: retry || !isRetryable(err) ? message : gaveUp(message),
        ...(retry ? {} : { slackStatus: "failed" as const }),
      });
      logger[retry ? "warn" : "error"]("slack_notification_failed", {
        runId: run.id,
        retryable: retry,
        error: message,
      });
      if (retry) return message;
    }
  }

  const failed = run.githubStatus === "failed" || run.slackStatus === "failed";
  await updateRun(db, run.id, { status: failed ? "failed" : "succeeded", completedAt: new Date() });
  return null;
}

/**
 * Used when a job ends without processEvent finishing (unexpected errors on the final
 * attempt, or a worker that died during it): the event and every unfinished step are
 * marked failed with the reason, so nothing stays "processing" forever.
 */
export async function abandonEvent(db: Db, webhookEventId: string, reason: string): Promise<void> {
  const message = reason.slice(0, 500);
  await db
    .update(webhookEvents)
    .set({ status: "failed", errorMessage: message, processedAt: new Date() })
    .where(
      and(eq(webhookEvents.id, webhookEventId), inArray(webhookEvents.status, ["received", "processing"])),
    );
  await db
    .update(automationRuns)
    .set({
      status: "failed",
      completedAt: new Date(),
      updatedAt: new Date(),
      githubStatus: sql`case when ${automationRuns.githubStatus} = 'pending' then 'failed'::step_status else ${automationRuns.githubStatus} end`,
      githubError: sql`case when ${automationRuns.githubStatus} = 'pending' then ${message} else ${automationRuns.githubError} end`,
      slackStatus: sql`case when ${automationRuns.slackStatus} = 'pending' then 'failed'::step_status else ${automationRuns.slackStatus} end`,
      slackError: sql`case when ${automationRuns.slackStatus} = 'pending' then ${message} else ${automationRuns.slackError} end`,
    })
    .where(
      and(
        eq(automationRuns.webhookEventId, webhookEventId),
        inArray(automationRuns.status, ["pending", "running"]),
      ),
    );
}
