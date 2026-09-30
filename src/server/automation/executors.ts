import "server-only";
import type { Db } from "../db";
import type { AutomationRun, EventSubject, GitHubStepResult, Repository, WebhookEvent } from "../db/schema";
import type { Env } from "../env";
import { StepError } from "./errors";

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
 * Production executors. GitHub write-back and Slack delivery are implemented in the next
 * steps; until then they fail honestly (permanent, visible in the run) instead of
 * pretending to succeed. No rule can be created yet, so production never reaches them.
 */
export const productionExecutors: Executors = {
  github: async () => {
    throw new StepError("GitHub write-back is not available in this build yet.", false);
  },
  slack: async () => {
    throw new StepError("Slack notifications are not available in this build yet.", false);
  },
};
