import "server-only";
import { postSlackMessage } from "../slack/client";
import { buildRunNotification } from "../slack/message";
import { resolveSlackWebhook } from "../slack/settings";
import type { SlackStepOutput, StepContext } from "./executors";

/**
 * The Slack step of a run. Runs after the GitHub step is terminal and reports its real
 * outcome. No configured webhook → skipped with the reason (not a failure, never "sent").
 * SlackError carries `retryable` (429/5xx/network) for the retry logic.
 */
export async function sendSlackNotification(ctx: StepContext): Promise<SlackStepOutput> {
  const target = await resolveSlackWebhook(ctx.db, ctx.env, ctx.repository.userId);
  if (target.url === null) return { status: "skipped", reason: target.reason };
  await postSlackMessage(
    target.url,
    buildRunNotification({
      run: ctx.run,
      event: ctx.event,
      subject: ctx.subject,
      repository: ctx.repository,
    }),
  );
  return { status: "sent" };
}
