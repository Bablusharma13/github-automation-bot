import { describe, expect, it } from "vitest";
import type { EventDTO, RunDTO } from "@/lib/activity-types";
import { describeRunAction, eventSummary } from "@/components/activity-status";

const run = (overrides: Partial<RunDTO> = {}): RunDTO => ({
  id: "r1",
  ruleId: "rule1",
  ruleName: "Bug issue automation",
  actionType: "add_label",
  actionValue: "bug",
  status: "succeeded",
  githubStatus: "succeeded",
  githubAttempts: 1,
  githubResult: { labelName: "bug", alreadyApplied: false },
  githubError: null,
  slackStatus: "succeeded",
  slackAttempts: 1,
  slackError: null,
  startedAt: null,
  completedAt: null,
  createdAt: new Date().toISOString(),
  ...overrides,
});

const event = (overrides: Partial<EventDTO> = {}): EventDTO => ({
  id: "e1",
  deliveryId: "d1",
  eventType: "issues",
  action: "opened",
  repoFullName: "o/r",
  senderLogin: "octo",
  subject: null,
  status: "processed",
  ignoreReason: null,
  errorMessage: null,
  receivedAt: new Date().toISOString(),
  processedAt: null,
  job: null,
  runs: [],
  ...overrides,
});

describe("eventSummary", () => {
  it("explains a processed event that no rule matched", () => {
    expect(eventSummary(event())).toMatchObject({ label: "No rule matched", tone: "gray" });
  });
  it("distinguishes success from completed-with-failures", () => {
    expect(eventSummary(event({ runs: [run()] })).label).toBe("Succeeded");
    expect(eventSummary(event({ runs: [run(), run({ id: "r2", status: "failed" })] })).label).toBe(
      "Completed with failures",
    );
  });
  it("shows retries with the attempt count and the last error", () => {
    const s = eventSummary(
      event({
        status: "processing",
        job: {
          status: "pending",
          attempts: 2,
          maxAttempts: 6,
          runAt: new Date(Date.now() + 60_000).toISOString(),
          lastError: "GitHub 502",
          completedAt: null,
        },
      }),
    );
    expect(s.label).toBe("Retrying (2/6)");
    expect(s.detail).toMatch(/next attempt in 1 minute — GitHub 502/);
  });
  it("covers ignored, queued, processing and failed events", () => {
    expect(
      eventSummary(event({ status: "ignored", ignoreReason: "repository_not_connected" })),
    ).toMatchObject({
      label: "Ignored",
      detail: "repository not connected",
    });
    expect(eventSummary(event({ status: "received" })).label).toBe("Queued");
    expect(eventSummary(event({ status: "processing" })).label).toBe("Processing");
    expect(eventSummary(event({ status: "failed", errorMessage: "Gave up" }))).toMatchObject({
      label: "Failed",
      detail: "Gave up",
    });
  });
});

describe("describeRunAction", () => {
  it("describes label and comment outcomes", () => {
    expect(describeRunAction(run())).toBe("Added label “bug”");
    expect(describeRunAction(run({ githubResult: { labelName: "Bug", alreadyApplied: true } }))).toBe(
      "Label “Bug” already present",
    );
    expect(describeRunAction(run({ githubStatus: "failed", githubResult: null }))).toBe("Add label “bug”");
    expect(describeRunAction(run({ actionType: "add_comment", githubResult: { commentId: 1 } }))).toBe(
      "Posted comment",
    );
  });
});
