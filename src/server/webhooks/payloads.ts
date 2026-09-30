import { z } from "zod";
import type { EventSubject } from "../db/schema";

/** Event types the automation acts on; everything else is recorded as ignored. */
export const SUPPORTED_EVENTS = ["issues", "pull_request"] as const;
export type SupportedEvent = (typeof SUPPORTED_EVENTS)[number];

export function isSupportedEvent(event: string): event is SupportedEvent {
  return (SUPPORTED_EVENTS as readonly string[]).includes(event);
}

const MAX_BODY_CHARS = 10_000; // enough for keyword matching and summaries

const repositorySchema = z.object({ id: z.number().int().positive(), full_name: z.string().min(1) });
const senderSchema = z.object({ login: z.string() }).nullable().optional();

/** Fields every repository webhook carries; lenient so unknown event types still parse. */
export const envelopeSchema = z.object({
  action: z.string().max(100).optional(),
  repository: repositorySchema.optional(),
  sender: senderSchema,
});

const labelsSchema = z
  .array(z.object({ name: z.string() }))
  .nullable()
  .optional()
  .transform((labels) => (labels ?? []).map((l) => l.name));

const itemSchema = z.object({
  number: z.number().int().positive(),
  title: z.string(),
  body: z.string().nullable().optional(),
  html_url: z.url(),
  state: z.string(),
  user: z.object({ login: z.string() }).nullable().optional(),
  labels: labelsSchema,
});

const issuesPayloadSchema = z.object({ repository: repositorySchema, issue: itemSchema });
const pullRequestPayloadSchema = z.object({ repository: repositorySchema, pull_request: itemSchema });

/**
 * Extracts the part of an issues / pull_request payload we keep for processing and
 * display. Returns null when the payload lacks required fields.
 */
export function extractSubject(event: SupportedEvent, payload: unknown): EventSubject | null {
  const parsed =
    event === "issues" ? issuesPayloadSchema.safeParse(payload) : pullRequestPayloadSchema.safeParse(payload);
  if (!parsed.success) return null;
  const item = "issue" in parsed.data ? parsed.data.issue : parsed.data.pull_request;
  return {
    kind: event === "issues" ? "issue" : "pull_request",
    number: item.number,
    title: item.title.slice(0, 1_000),
    body: (item.body ?? "").slice(0, MAX_BODY_CHARS),
    url: item.html_url,
    state: item.state,
    author: item.user?.login ?? null,
    labels: item.labels,
  };
}
