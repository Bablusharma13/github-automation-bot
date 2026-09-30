import "server-only";
import type { Db } from "../db";
import type { AutomationRun, EventSubject, GitHubStepResult, Repository, WebhookEvent } from "../db/schema";
import type { Env } from "../env";
import { executeGitHubAction } from "./github-executor";

export type StepContext = {
  db: Db;
  env: Env;
  run: AutomationRun;
  event: WebhookEvent;
  subject: EventSubject;
  repository: Repository;
};

export type SlackStepOutput = { status: "sent" } | { status: "skipped"; reason: string };

/**
 * Side-effecting steps of an automation run. Implementations must be idempotent: a step
 * can be re-executed after a crash between performing it and recording it (e.g. the
 * GitHub step checks whether the label/comment already exists before writing).
 * Throw errors with `retryable` to control retries.
 */
export type Executors = {
  github: (ctx: StepContext) => Promise<GitHubStepResult>;
  /** Called once the GitHub step is terminal; `ctx.run` carries its outcome. */
  slack: (ctx: StepContext) => Promise<SlackStepOutput>;
};

/**
 * Production executors. Slack delivery is the next step to be implemented; until then the
 * Slack step is recorded as skipped with that reason — never reported as sent — so the
 * run's status reflects the real GitHub outcome.
 */
export const productionExecutors: Executors = {
  github: executeGitHubAction,
  slack: async () => ({
    status: "skipped",
    reason: "Slack notifications are not available in this build yet.",
  }),
};
