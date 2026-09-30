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
import type { Executors, StepContext, TriageContext } from "./executors";

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

/** Added to every log line about an event, so one delivery can be traced end to end. */
type LogContext = { eventId: string; deliveryId: string; repository: string | null; attempt: number };
type StepOutcome = { run: AutomationRun; retry: string | null };

/**
 * Processes one webhook event. Safe to call any number of times for the same event:
 *
 * - Runs are UNIQUE per (event, rule) and inserted with ON CONFLICT DO NOTHING, so a
 *   retried job reuses its runs instead of creating new ones.
 * - Each run has two steps with their own persisted status — GitHub write-back, then the
 *   Slack notification. A step that succeeded is never executed again, so a Slack failure
 *   cannot repeat (or undo) the GitHub action.
 * - Order: the GitHub steps of all runs, then the optional AI triage (once per event),
 *   then Slack. The write-back never waits on the AI, and notifications can include it.
 * - Slack waits until the GitHub step is terminal, so the notification reports the real
 *   outcome, including failures.
 * - AI triage is best-effort: its failure is recorded on the event and never causes a
 *   retry or blocks the other steps.
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
  const startedAt = Date.now();
  const [event] = await db
    .select()
    .from(webhookEvents)
    .where(eq(webhookEvents.id, input.webhookEventId))
    .limit(1);
  if (!event || event.status === "processed" || event.status === "ignored") return { kind: "done" };
  const log: LogContext = {
    eventId: event.id,
    deliveryId: event.deliveryId,
    repository: event.repoFullName,
    attempt: input.attempt,
  };

  const [repository] = event.repositoryId
    ? await db.select().from(repositories).where(eq(repositories.id, event.repositoryId)).limit(1)
    : [];
  if (!repository || !repository.active || !event.subject || !event.userId) {
    await db
      .update(webhookEvents)
      .set({ status: "ignored", ignoreReason: "repository_disconnected", processedAt: new Date() })
      .where(eq(webhookEvents.id, event.id));
    logger.info("event_ignored_at_processing", { ...log, reason: "repository_disconnected" });
    return { kind: "done" };
  }
  if (event.status !== "processing") {
    await db.update(webhookEvents).set({ status: "processing" }).where(eq(webhookEvents.id, event.id));
  }

  const matched = await matchRules(db, event);
  logger.info("rules_evaluated", { ...log, matched: matched.length });
  for (const rule of matched) {
    logger.info("rule_matched", { ...log, ruleId: rule.id, ruleName: rule.name, action: rule.actionType });
  }
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
  const subject = event.subject;
  let retryError: string | null = null;

  // 1. GitHub write-back for every unfinished run.
  const open: AutomationRun[] = [];
  for (const stored of runs) {
    if (stored.status === "succeeded" || stored.status === "failed") continue;
    const run =
      stored.status === "pending"
        ? await updateRun(db, stored.id, { status: "running", startedAt: stored.startedAt ?? new Date() })
        : stored;
    const step = await runGitHubStep({ db, env, run, event, subject, repository }, executors, input, log);
    if (step.retry && !retryError) retryError = step.retry;
    open.push(step.run);
  }

  // 2. AI triage, at most once per event (a manual retry clears a failed one).
  let current: WebhookEvent = event;
  if (event.aiStatus === null && matched.some((rule) => rule.aiTriage)) {
    current = await runTriageStep({ db, env, event, subject, repository }, executors, log);
  }

  // 3. Slack, for runs whose GitHub step has a final outcome to report.
  for (const run of open) {
    if (run.githubStatus === "pending") continue;
    const step = await runSlackStep(
      { db, env, run, event: current, subject, repository },
      executors,
      input,
      log,
    );
    if (step.retry) {
      if (!retryError) retryError = step.retry;
      continue;
    }
    const failed = step.run.githubStatus === "failed" || step.run.slackStatus === "failed";
    await updateRun(db, run.id, { status: failed ? "failed" : "succeeded", completedAt: new Date() });
  }
  if (retryError) return { kind: "retry", error: retryError };

  await db
    .update(webhookEvents)
    .set({ status: "processed", processedAt: new Date(), errorMessage: null })
    .where(eq(webhookEvents.id, event.id));
  logger.info("event_processed", { ...log, runs: runs.length, durationMs: Date.now() - startedAt });
  return { kind: "done" };
}

const gaveUp = (message: string, attempt: number) => `${message} (gave up after ${attempt} attempts)`;

async function runGitHubStep(
  ctx: StepContext,
  executors: Executors,
  input: ProcessInput,
  log: LogContext,
): Promise<StepOutcome> {
  const { db } = ctx;
  let run = ctx.run;
  if (run.githubStatus !== "pending") return { run, retry: null };
  const attempts = run.githubAttempts + 1;
  const startedAt = Date.now();
  try {
    const result = await executors.github(ctx);
    run = await updateRun(db, run.id, {
      githubStatus: "succeeded",
      githubAttempts: attempts,
      githubResult: result,
      githubError: null,
    });
    logger.info("github_action_succeeded", {
      ...log,
      runId: run.id,
      action: run.actionType,
      result,
      durationMs: Date.now() - startedAt,
    });
    return { run, retry: null };
  } catch (err) {
    const message = describeError(err);
    const retry = isRetryable(err) && !input.isFinalAttempt;
    run = await updateRun(db, run.id, {
      githubAttempts: attempts,
      githubError: retry || !isRetryable(err) ? message : gaveUp(message, input.attempt),
      ...(retry ? {} : { githubStatus: "failed" as const }),
    });
    logger[retry ? "warn" : "error"]("github_action_failed", {
      ...log,
      runId: run.id,
      retryable: retry,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    // A retryable failure leaves the step pending; Slack waits for the final outcome.
    return { run, retry: retry ? message : null };
  }
}

async function runSlackStep(
  ctx: StepContext,
  executors: Executors,
  input: ProcessInput,
  log: LogContext,
): Promise<StepOutcome> {
  const { db } = ctx;
  let run = ctx.run;
  if (run.slackStatus !== "pending") return { run, retry: null };
  const attempts = run.slackAttempts + 1;
  const startedAt = Date.now();
  try {
    const out = await executors.slack(ctx);
    run = await updateRun(
      db,
      run.id,
      out.status === "sent"
        ? { slackStatus: "succeeded", slackAttempts: attempts, slackError: null }
        : { slackStatus: "skipped", slackAttempts: attempts, slackError: out.reason },
    );
    logger.info(out.status === "sent" ? "slack_notification_sent" : "slack_notification_skipped", {
      ...log,
      runId: run.id,
      ...(out.status === "skipped" ? { reason: out.reason } : {}),
      durationMs: Date.now() - startedAt,
    });
    return { run, retry: null };
  } catch (err) {
    const message = describeError(err);
    const retry = isRetryable(err) && !input.isFinalAttempt;
    run = await updateRun(db, run.id, {
      slackAttempts: attempts,
      slackError: retry || !isRetryable(err) ? message : gaveUp(message, input.attempt),
      ...(retry ? {} : { slackStatus: "failed" as const }),
    });
    logger[retry ? "warn" : "error"]("slack_notification_failed", {
      ...log,
      runId: run.id,
      retryable: retry,
      error: message,
      durationMs: Date.now() - startedAt,
    });
    return { run, retry: retry ? message : null };
  }
}

/**
 * Records the triage outcome on the event and returns the updated row. Never throws for
 * AI problems: a failed suggestion is shown as failed, and everything else carries on.
 */
async function runTriageStep(
  ctx: TriageContext,
  executors: Executors,
  log: LogContext,
): Promise<WebhookEvent> {
  const startedAt = Date.now();
  let values: Pick<typeof webhookEvents.$inferInsert, "aiStatus" | "aiResult" | "aiModel" | "aiError">;
  try {
    const out = await executors.triage(ctx);
    if (out.status === "succeeded") {
      values = { aiStatus: "succeeded", aiResult: out.result, aiModel: out.model, aiError: null };
      logger.info("ai_triage_succeeded", {
        ...log,
        model: out.model,
        suggestedLabel: out.result.suggestedLabel,
        priority: out.result.priority,
        durationMs: Date.now() - startedAt,
      });
    } else {
      values = { aiStatus: "skipped", aiResult: null, aiModel: null, aiError: out.reason };
      logger.info("ai_triage_skipped", { ...log, reason: out.reason });
    }
  } catch (err) {
    const message = describeError(err);
    values = { aiStatus: "failed", aiResult: null, aiModel: null, aiError: message };
    logger.warn("ai_triage_failed", {
      ...log,
      retryable: isRetryable(err),
      error: message,
      durationMs: Date.now() - startedAt,
    });
  }
  const [row] = await ctx.db
    .update(webhookEvents)
    .set({ ...values, aiCompletedAt: new Date() })
    .where(eq(webhookEvents.id, ctx.event.id))
    .returning();
  return row!;
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
