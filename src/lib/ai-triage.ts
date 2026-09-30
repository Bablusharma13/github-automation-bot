/**
 * AI triage vocabulary shared by the server (output validation) and the dashboard.
 * No server code here — safe to import from client components.
 *
 * The triage is a display-only suggestion: nothing in the bot acts on these values.
 */
export const AI_SUGGESTED_LABELS = [
  "bug",
  "enhancement",
  "documentation",
  "question",
  "security",
  "none",
] as const;
export const AI_PRIORITIES = ["low", "medium", "high", "critical"] as const;

export type AiSuggestedLabel = (typeof AI_SUGGESTED_LABELS)[number];
export type AiPriority = (typeof AI_PRIORITIES)[number];

export type AiTriage = {
  summary: string;
  suggestedLabel: AiSuggestedLabel;
  priority: AiPriority;
};

/** Stored summaries are clipped to this length whatever the model returns. */
export const AI_SUMMARY_MAX = 300;
