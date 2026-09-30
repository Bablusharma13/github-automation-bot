import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { StepError } from "@/server/automation/errors";
import type { Executors, SlackStepOutput, StepContext } from "@/server/automation/executors";
import { abandonEvent, processEvent } from "@/server/automation/process-event";
import type { Db } from "@/server/db";
import { automationRuns, repositories } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import { GitHubApiError } from "@/server/github/api";
import { createTestDb } from "../helpers/db";
import {
  createEvent,
  createOwnerWithRepo,
  createRule,
  issueSubject,
  reloadEvent,
  runsFor,
} from "../helpers/fixtures";

let db: Db;
let close: () => Promise<void>;
let env: Env;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv();
});
afterAll(async () => close());

const newOwner = () => createOwnerWithRepo(db, env, `pe-owner-${++seq}`);

type Step = "ok" | Error;
/** Fake executors driven by a script per step; records every call. */
function fakeExecutors(script: { github?: Step[]; slack?: Array<Step | SlackStepOutput> } = {}) {
  const calls = { github: [] as StepContext[], slack: [] as StepContext[] };
  const executors: Executors = {
    github: async (ctx) => {
      calls.github.push(ctx);
      const next = script.github?.shift() ?? "ok";
      if (next instanceof Error) throw next;
      return { labelName: ctx.run.actionValue, alreadyApplied: false };
    },
    slack: async (ctx) => {
      calls.slack.push(ctx);
      const next = script.slack?.shift() ?? "ok";
      if (next instanceof Error) throw next;
      return next === "ok" ? { status: "sent" } : next;
    },
  };
  return { executors, calls };
}

const attempt = (eventId: string, n: number, isFinalAttempt = false) => ({
  webhookEventId: eventId,
  attempt: n,
  isFinalAttempt,
});
const transient = () => new GitHubApiError("GitHub POST /labels → 502: Bad Gateway", 502, true);
const permanent = () =>
  new GitHubApiError("GitHub POST /labels → 422: Validation Failed (label does not exist)", 422, false);

describe("processEvent: rule evaluation", () => {
  it("marks an event without matching rules processed and creates no runs", async () => {
    const o = await newOwner();
    await createRule(db, o, { keywords: ["security"] });
    const { event } = await createEvent(db, o);
    const { executors, calls } = fakeExecutors();
    expect(await processEvent(db, env, attempt(event.id, 1), executors)).toEqual({ kind: "done" });
    expect((await reloadEvent(db, event.id)).status).toBe("processed");
    expect(await runsFor(db, event.id)).toHaveLength(0);
    expect(calls.github).toHaveLength(0);
  });

  it("ignores disabled rules and rules for other actions", async () => {
    const o = await newOwner();
    await createRule(db, o, { enabled: false });
    await createRule(db, o, { eventActions: ["closed"] });
    const { event } = await createEvent(db, o);
    await processEvent(db, env, attempt(event.id, 1), fakeExecutors().executors);
    expect(await runsFor(db, event.id)).toHaveLength(0);
  });

  it("creates one run per matching rule", async () => {
    const o = await newOwner();
    await createRule(db, o, { name: "label bug" });
    await createRule(db, o, {
      name: "comment",
      actionType: "add_comment",
      actionValue: "Thanks!",
      keywords: [],
    });
    await createRule(db, o, { name: "not matching", keywords: ["docs"] });
    const { event } = await createEvent(db, o);
    await processEvent(db, env, attempt(event.id, 1), fakeExecutors().executors);
    const runs = await runsFor(db, event.id);
    expect(runs.map((r) => r.ruleName).sort()).toEqual(["comment", "label bug"]);
  });

  it("does not evaluate other users' rules for this repository's events", async () => {
    const o = await newOwner();
    const other = await newOwner();
    // A rule owned by someone else but pointing at o's repository must never run.
    await createRule(db, { user: other.user, repo: o.repo });
    const { event } = await createEvent(db, o);
    await processEvent(db, env, attempt(event.id, 1), fakeExecutors().executors);
    expect(await runsFor(db, event.id)).toHaveLength(0);
  });
});

describe("processEvent: steps, retries and idempotency", () => {
  it("runs the GitHub step, then Slack, and records success", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event } = await createEvent(db, o);
    const { executors, calls } = fakeExecutors();
    expect(await processEvent(db, env, attempt(event.id, 1), executors)).toEqual({ kind: "done" });
    const [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({
      status: "succeeded",
      githubStatus: "succeeded",
      githubAttempts: 1,
      githubResult: { labelName: "bug", alreadyApplied: false },
      slackStatus: "succeeded",
      slackAttempts: 1,
    });
    expect(calls.github).toHaveLength(1);
    expect(calls.slack).toHaveLength(1);
    // Slack sees the GitHub outcome it is reporting.
    expect(calls.slack[0]!.run.githubStatus).toBe("succeeded");
    expect((await reloadEvent(db, event.id)).status).toBe("processed");
  });

  it("is idempotent: re-processing a finished event performs no side effects", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event } = await createEvent(db, o);
    await processEvent(db, env, attempt(event.id, 1), fakeExecutors().executors);
    const second = fakeExecutors();
    expect(await processEvent(db, env, attempt(event.id, 2), second.executors)).toEqual({ kind: "done" });
    expect(second.calls.github).toHaveLength(0);
    expect(second.calls.slack).toHaveLength(0);
    expect(await runsFor(db, event.id)).toHaveLength(1);
  });

  it("retries a transient GitHub failure and holds Slack until GitHub is done", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event } = await createEvent(db, o);
    const { executors, calls } = fakeExecutors({ github: [transient(), "ok"] });

    const first = await processEvent(db, env, attempt(event.id, 1), executors);
    expect(first.kind).toBe("retry");
    let [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({
      status: "running",
      githubStatus: "pending",
      githubAttempts: 1,
      slackStatus: "pending",
    });
    expect(run!.githubError).toMatch(/502/);
    expect(calls.slack).toHaveLength(0);
    expect((await reloadEvent(db, event.id)).status).toBe("processing");

    expect(await processEvent(db, env, attempt(event.id, 2), executors)).toEqual({ kind: "done" });
    [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({
      status: "succeeded",
      githubStatus: "succeeded",
      githubAttempts: 2,
      githubError: null,
    });
    expect(calls.github).toHaveLength(2);
    expect(calls.slack).toHaveLength(1);
  });

  it("retries a Slack failure without repeating the successful GitHub action", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event } = await createEvent(db, o);
    const { executors, calls } = fakeExecutors({ slack: [new StepError("Slack returned 503", true), "ok"] });

    expect((await processEvent(db, env, attempt(event.id, 1), executors)).kind).toBe("retry");
    let [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ githubStatus: "succeeded", slackStatus: "pending", slackAttempts: 1 });

    expect(await processEvent(db, env, attempt(event.id, 2), executors)).toEqual({ kind: "done" });
    [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ status: "succeeded", slackStatus: "succeeded", slackAttempts: 2 });
    expect(calls.github).toHaveLength(1); // never repeated
    expect(calls.slack).toHaveLength(2);
  });

  it("does not retry a permanent GitHub failure but still notifies Slack about it", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event } = await createEvent(db, o);
    const { executors, calls } = fakeExecutors({ github: [permanent()] });
    expect(await processEvent(db, env, attempt(event.id, 1), executors)).toEqual({ kind: "done" });
    const [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ status: "failed", githubStatus: "failed", slackStatus: "succeeded" });
    expect(run!.githubError).toMatch(/label does not exist/);
    expect(calls.slack[0]!.run.githubStatus).toBe("failed");
  });

  it("records a transient error as final on the last attempt instead of asking for another retry", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event } = await createEvent(db, o);
    const { executors } = fakeExecutors({ github: [transient()] });
    expect(await processEvent(db, env, attempt(event.id, 6, true), executors)).toEqual({ kind: "done" });
    const [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ status: "failed", githubStatus: "failed" });
    expect(run!.githubError).toMatch(/gave up after 6 attempts/);
  });

  it("skips Slack when the rule does not notify, and records a skipped notification", async () => {
    const o = await newOwner();
    await createRule(db, o, { notifySlack: false });
    const { event } = await createEvent(db, o);
    const { executors, calls } = fakeExecutors();
    await processEvent(db, env, attempt(event.id, 1), executors);
    const [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ status: "succeeded", slackStatus: "skipped" });
    expect(calls.slack).toHaveLength(0);

    const o2 = await newOwner();
    await createRule(db, o2);
    const { event: e2 } = await createEvent(db, o2);
    await processEvent(
      db,
      env,
      attempt(e2.id, 1),
      fakeExecutors({ slack: [{ status: "skipped", reason: "No Slack webhook configured" }] }).executors,
    );
    const [run2] = await runsFor(db, e2.id);
    expect(run2).toMatchObject({ slackStatus: "skipped", slackError: "No Slack webhook configured" });
  });

  it("ignores the event if the repository was disconnected before processing", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event } = await createEvent(db, o);
    await db.update(repositories).set({ active: false }).where(eq(repositories.id, o.repo.id));
    const { executors, calls } = fakeExecutors();
    await processEvent(db, env, attempt(event.id, 1), executors);
    expect(await reloadEvent(db, event.id)).toMatchObject({
      status: "ignored",
      ignoreReason: "repository_disconnected",
    });
    expect(calls.github).toHaveLength(0);
  });

  it("keeps using the rule snapshot even if the rule is deleted before a retry", async () => {
    const o = await newOwner();
    const rule = await createRule(db, o);
    const { event } = await createEvent(db, o, { subject: issueSubject({ title: "bug: flaky test" }) });
    const { executors } = fakeExecutors({ github: [transient(), "ok"] });
    await processEvent(db, env, attempt(event.id, 1), executors);
    await db
      .delete((await import("@/server/db/schema")).rules)
      .where(eq((await import("@/server/db/schema")).rules.id, rule.id));
    expect(await processEvent(db, env, attempt(event.id, 2), executors)).toEqual({ kind: "done" });
    const [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ ruleId: null, ruleName: "Bug issue automation", status: "succeeded" });
  });
});

describe("abandonEvent", () => {
  it("fails the event and every unfinished step with the reason", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event } = await createEvent(db, o);
    await processEvent(db, env, attempt(event.id, 1), fakeExecutors({ github: [transient()] }).executors);
    await abandonEvent(db, event.id, "Gave up after 6 attempts: GitHub unreachable");
    expect(await reloadEvent(db, event.id)).toMatchObject({ status: "failed" });
    const [run] = await db.select().from(automationRuns).where(eq(automationRuns.webhookEventId, event.id));
    expect(run).toMatchObject({
      status: "failed",
      githubStatus: "failed",
      githubError: "Gave up after 6 attempts: GitHub unreachable",
      slackStatus: "failed",
    });
  });
});
