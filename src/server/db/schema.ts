import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { AiTriage } from "../../lib/ai-triage";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
};

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const ruleEventTypeEnum = pgEnum("rule_event_type", ["issues", "pull_request"]);
export const ruleActionTypeEnum = pgEnum("rule_action_type", ["add_label", "add_comment"]);
export const keywordScopeEnum = pgEnum("keyword_scope", ["title", "title_and_body"]);
export const eventStatusEnum = pgEnum("event_status", [
  "received",
  "processing",
  "processed",
  "ignored",
  "failed",
]);
export const jobStatusEnum = pgEnum("job_status", ["pending", "running", "succeeded", "failed"]);
export const runStatusEnum = pgEnum("run_status", ["pending", "running", "succeeded", "failed"]);
export const stepStatusEnum = pgEnum("step_status", ["pending", "succeeded", "skipped", "failed"]);

// ---------------------------------------------------------------------------
// Users & sessions
// ---------------------------------------------------------------------------

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  githubUserId: bigint("github_user_id", { mode: "number" }).notNull().unique(),
  githubLogin: text("github_login").notNull(),
  name: text("name"),
  email: text("email"),
  avatarUrl: text("avatar_url"),
  /** AES-256-GCM encrypted OAuth access token. Never leaves the server. */
  accessTokenEnc: text("access_token_enc").notNull(),
  /** Null when the OAuth app issues non-expiring tokens. GitHub's expiring tokens last 8h. */
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  /** Encrypted refresh token (rotated on every refresh; lasts 6 months). */
  refreshTokenEnc: text("refresh_token_enc"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  /**
   * Set when GitHub rejects our credentials (revoked or expired refresh token). Background
   * automation for this user fails fast with a clear reason until they sign in again.
   */
  githubReauthRequiredAt: timestamp("github_reauth_required_at", { withTimezone: true }),
  tokenScopes: text("token_scopes"),
  /** Optional per-user Slack Incoming Webhook URL (encrypted). Falls back to SLACK_WEBHOOK_URL. */
  slackWebhookUrlEnc: text("slack_webhook_url_enc"),
  ...timestamps,
});

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the session token; the raw token only exists in the user's cookie. */
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_id_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Repositories & rules
// ---------------------------------------------------------------------------

export const repositories = pgTable(
  "repositories",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    githubRepoId: bigint("github_repo_id", { mode: "number" }).notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    fullName: text("full_name").notNull(),
    private: boolean("private").notNull().default(false),
    htmlUrl: text("html_url").notNull(),
    /** Id of the repository webhook we created on GitHub (null when disconnected). */
    webhookId: bigint("webhook_id", { mode: "number" }),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    index("repositories_user_id_idx").on(t.userId),
    // A user reconnecting a repo reuses their row.
    uniqueIndex("repositories_user_repo_uq").on(t.userId, t.githubRepoId),
    // At most one *active* connection per GitHub repository, so deliveries route to
    // exactly one owner.
    uniqueIndex("repositories_active_repo_uq")
      .on(t.githubRepoId)
      .where(sql`${t.active} = true`),
  ],
);

export const rules = pgTable(
  "rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    eventType: ruleEventTypeEnum("event_type").notNull(),
    /** Webhook `action` values that trigger the rule, e.g. ["opened"]. */
    eventActions: text("event_actions")
      .array()
      .notNull()
      .default(sql`ARRAY['opened']::text[]`),
    /** Case-insensitive; the rule matches if ANY keyword is found. Empty = always match. */
    keywords: text("keywords")
      .array()
      .notNull()
      .default(sql`ARRAY[]::text[]`),
    keywordScope: keywordScopeEnum("keyword_scope").notNull().default("title"),
    actionType: ruleActionTypeEnum("action_type").notNull(),
    /** Label name for add_label; comment body for add_comment. */
    actionValue: text("action_value").notNull(),
    notifySlack: boolean("notify_slack").notNull().default(true),
    /** Ask the AI for a triage suggestion (display-only) when this rule matches. */
    aiTriage: boolean("ai_triage").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("rules_repository_id_idx").on(t.repositoryId), index("rules_user_id_idx").on(t.userId)],
);

// ---------------------------------------------------------------------------
// Events, jobs, runs
// ---------------------------------------------------------------------------

/** The subset of the webhook payload we keep for processing and display. */
export type EventSubject = {
  kind: "issue" | "pull_request";
  number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  author: string | null;
  labels: string[];
};

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** X-GitHub-Delivery. UNIQUE: the database is the arbiter of duplicate deliveries. */
    deliveryId: text("delivery_id").notNull().unique(),
    eventType: text("event_type").notNull(),
    action: text("action"),
    /** Owner at time of receipt, denormalised so ownership checks never depend on joins. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "set null" }),
    githubRepoId: bigint("github_repo_id", { mode: "number" }),
    repoFullName: text("repo_full_name"),
    senderLogin: text("sender_login"),
    subject: jsonb("subject").$type<EventSubject>(),
    status: eventStatusEnum("status").notNull().default("received"),
    ignoreReason: text("ignore_reason"),
    errorMessage: text("error_message"),
    /**
     * Optional AI triage, computed at most once per event (it is the same for every rule).
     * Null status = not requested. Suggestions only: no action ever depends on them.
     */
    aiStatus: stepStatusEnum("ai_status"),
    aiResult: jsonb("ai_result").$type<AiTriage>(),
    aiModel: text("ai_model"),
    aiError: text("ai_error"),
    aiCompletedAt: timestamp("ai_completed_at", { withTimezone: true }),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp("processed_at", { withTimezone: true }),
  },
  (t) => [
    index("webhook_events_user_received_idx").on(t.userId, t.receivedAt.desc()),
    index("webhook_events_repository_idx").on(t.repositoryId),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** One processing job per event (outbox row written in the same transaction). */
    webhookEventId: uuid("webhook_event_id")
      .notNull()
      .unique()
      .references(() => webhookEvents.id, { onDelete: "cascade" }),
    status: jobStatusEnum("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(6),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    /** Lease: a running job whose lease expired is considered abandoned and re-claimed. */
    lockedUntil: timestamp("locked_until", { withTimezone: true }),
    lastError: text("last_error"),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("jobs_status_run_at_idx").on(t.status, t.runAt)],
);

export type GitHubStepResult = {
  alreadyApplied?: boolean;
  labelName?: string;
  commentId?: number;
  commentUrl?: string;
};

export const automationRuns = pgTable(
  "automation_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    webhookEventId: uuid("webhook_event_id")
      .notNull()
      .references(() => webhookEvents.id, { onDelete: "cascade" }),
    ruleId: uuid("rule_id").references(() => rules.id, { onDelete: "set null" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    repositoryId: uuid("repository_id").references(() => repositories.id, { onDelete: "set null" }),
    /** Snapshot of the rule at match time; rules can be edited or deleted later. */
    ruleName: text("rule_name").notNull(),
    actionType: ruleActionTypeEnum("action_type").notNull(),
    actionValue: text("action_value").notNull(),
    status: runStatusEnum("status").notNull().default("pending"),

    githubStatus: stepStatusEnum("github_status").notNull().default("pending"),
    githubAttempts: integer("github_attempts").notNull().default(0),
    githubResult: jsonb("github_result").$type<GitHubStepResult>(),
    githubError: text("github_error"),

    slackStatus: stepStatusEnum("slack_status").notNull().default("pending"),
    slackAttempts: integer("slack_attempts").notNull().default(0),
    slackError: text("slack_error"),

    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    // A rule produces at most one run per event, even if the job is re-executed.
    uniqueIndex("automation_runs_event_rule_uq").on(t.webhookEventId, t.ruleId),
    index("automation_runs_user_created_idx").on(t.userId, t.createdAt.desc()),
  ],
);

// ---------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
  count: integer("count").notNull(),
});

export type User = typeof users.$inferSelect;
export type Repository = typeof repositories.$inferSelect;
export type Rule = typeof rules.$inferSelect;
export type WebhookEvent = typeof webhookEvents.$inferSelect;
export type Job = typeof jobs.$inferSelect;
export type AutomationRun = typeof automationRuns.$inferSelect;
