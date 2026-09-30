/** Activity data as the dashboard receives it (no secrets, no tokens, no payloads). */

export type StepStatus = "pending" | "succeeded" | "skipped" | "failed";

export type RunDTO = {
  id: string;
  ruleId: string | null;
  ruleName: string;
  actionType: "add_label" | "add_comment";
  actionValue: string;
  status: "pending" | "running" | "succeeded" | "failed";
  githubStatus: StepStatus;
  githubAttempts: number;
  githubResult: {
    labelName?: string;
    alreadyApplied?: boolean;
    commentId?: number;
    commentUrl?: string;
  } | null;
  githubError: string | null;
  slackStatus: StepStatus;
  slackAttempts: number;
  slackError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
};

export type JobDTO = {
  status: "pending" | "running" | "succeeded" | "failed";
  attempts: number;
  maxAttempts: number;
  runAt: string;
  lastError: string | null;
  completedAt: string | null;
};

export type EventDTO = {
  id: string;
  deliveryId: string;
  eventType: string;
  action: string | null;
  repoFullName: string | null;
  senderLogin: string | null;
  subject: {
    kind: "issue" | "pull_request";
    number: number;
    title: string;
    url: string;
    author: string | null;
    labels: string[];
  } | null;
  status: "received" | "processing" | "processed" | "ignored" | "failed";
  ignoreReason: string | null;
  errorMessage: string | null;
  receivedAt: string;
  processedAt: string | null;
  job: JobDTO | null;
  runs: RunDTO[];
};

export type EventDetailDTO = EventDTO & { bodyPreview: string };

export type StatsDTO = {
  connectedRepositories: number;
  enabledRules: number;
  events24h: number;
  eventsTotal: number;
  actionsSucceeded: number;
  actionsFailed: number;
  retriesPending: number;
};

export type EventFilter = "all" | "failed" | "in_progress";
