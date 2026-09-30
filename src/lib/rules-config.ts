/**
 * Rule options shared by the API (validation) and the dashboard (form controls).
 * No server code here — safe to import from client components.
 */
export const RULE_EVENT_TYPES = ["issues", "pull_request"] as const;
export const RULE_EVENT_ACTIONS = ["opened", "edited", "reopened"] as const;
export const RULE_ACTION_TYPES = ["add_label", "add_comment"] as const;
export const RULE_KEYWORD_SCOPES = ["title", "title_and_body"] as const;

export type RuleEventType = (typeof RULE_EVENT_TYPES)[number];
export type RuleEventAction = (typeof RULE_EVENT_ACTIONS)[number];
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];
export type RuleKeywordScope = (typeof RULE_KEYWORD_SCOPES)[number];

export const RULE_LIMITS = {
  nameMax: 80,
  keywordsMax: 10,
  keywordMax: 50,
  /** GitHub's maximum label name length. */
  labelMax: 50,
  commentMax: 2_000,
} as const;

export const EVENT_TYPE_LABELS: Record<RuleEventType, string> = {
  issues: "Issue",
  pull_request: "Pull request",
};

export const ACTION_TYPE_LABELS: Record<RuleActionType, string> = {
  add_label: "Add label",
  add_comment: "Post comment",
};

export const KEYWORD_SCOPE_LABELS: Record<RuleKeywordScope, string> = {
  title: "title",
  title_and_body: "title or body",
};

/** What the browser receives for a rule. */
export type RuleDTO = {
  id: string;
  repositoryId: string;
  repositoryFullName: string;
  repositoryActive: boolean;
  name: string;
  enabled: boolean;
  eventType: RuleEventType;
  eventActions: RuleEventAction[];
  keywords: string[];
  keywordScope: RuleKeywordScope;
  actionType: RuleActionType;
  actionValue: string;
  notifySlack: boolean;
  aiTriage: boolean;
  createdAt: string;
  updatedAt: string;
};
