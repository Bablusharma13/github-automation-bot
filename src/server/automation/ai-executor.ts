import "server-only";
import { DEFAULT_GEMINI_MODEL, generateTriage } from "../ai/gemini";
import { consumeRateLimit } from "../rate-limit";
import { StepError } from "./errors";
import type { TriageContext, TriageOutput } from "./executors";

/**
 * Per account, so one busy (or spammed) repository cannot use up the deployment's shared
 * free-tier quota for everyone else.
 */
export const AI_TRIAGE_HOURLY_LIMIT = 30;

/** The AI triage step: a display-only suggestion for the event's issue or pull request. */
export async function runAiTriage(ctx: TriageContext): Promise<TriageOutput> {
  const apiKey = ctx.env.GEMINI_API_KEY;
  if (!apiKey) {
    return {
      status: "skipped",
      reason: "AI triage is not configured on this server (GEMINI_API_KEY is not set).",
    };
  }
  const limit = await consumeRateLimit(ctx.db, `ai:${ctx.repository.userId}`, AI_TRIAGE_HOURLY_LIMIT, 3600);
  if (!limit.allowed) {
    throw new StepError(
      `AI triage limit reached (${AI_TRIAGE_HOURLY_LIMIT} per hour per account); try again in ${Math.ceil(limit.retryAfterSeconds / 60)} min.`,
      true,
    );
  }
  const model = ctx.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL;
  const result = await generateTriage({
    apiKey,
    model,
    input: { kind: ctx.subject.kind, title: ctx.subject.title, body: ctx.subject.body },
  });
  return { status: "succeeded", result, model };
}
