import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AiTriage } from "@/lib/ai-triage";
import { AiError, DEFAULT_GEMINI_MODEL, GEMINI_API_URL } from "@/server/ai/gemini";
import type { AuthDeps } from "@/server/auth/handlers";
import { AI_TRIAGE_HOURLY_LIMIT, runAiTriage } from "@/server/automation/ai-executor";
import { StepError } from "@/server/automation/errors";
import { productionExecutors, type Executors } from "@/server/automation/executors";
import { processEvent } from "@/server/automation/process-event";
import type { Db } from "@/server/db";
import { rateLimits, type WebhookEvent } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import { getEventHandler, retryEventHandler } from "@/server/events/handlers";
import { createRuleHandler, listRulesHandler, updateRuleHandler } from "@/server/rules/handlers";
import { apiRequest } from "../helpers/auth";
import { createTestDb } from "../helpers/db";
import { json, mockFetch } from "../helpers/fetch-mock";
import {
  createEvent,
  createOwnerWithRepo,
  createRule,
  issueSubject,
  reloadEvent,
  runsFor,
} from "../helpers/fixtures";

const KEY = "test-gemini-key-do-not-leak-0123";
const DEFAULT_HOOK = "https://hooks.slack.com/services/TDEF/BDEF/defaultdefault";
const RESULT: AiTriage = {
  summary: "Sign-in fails after the session refreshes.",
  suggestedLabel: "bug",
  priority: "high",
};

let db: Db;
let close: () => Promise<void>;
let env: Env;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv(); // GEMINI_API_KEY is unset in tests
});
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());

const newOwner = () => createOwnerWithRepo(db, env, `ai-owner-${++seq}`);
const attempt = (eventId: string, n = 1) => ({ webhookEventId: eventId, attempt: n, isFinalAttempt: false });

/** Fake executors that record the order of steps and what Slack was given. */
function recording(triage: Executors["triage"], github?: Executors["github"]) {
  const order: string[] = [];
  const slackEvents: WebhookEvent[] = [];
  const executors: Executors = {
    github: async (ctx) => {
      order.push("github");
      return github ? github(ctx) : { labelName: ctx.run.actionValue, alreadyApplied: false };
    },
    triage: async (ctx) => {
      order.push("triage");
      return triage(ctx);
    },
    slack: async (ctx) => {
      order.push("slack");
      slackEvents.push(ctx.event);
      return { status: "sent" };
    },
  };
  return { executors, order, slackEvents };
}
const succeeds: Executors["triage"] = async () => ({
  status: "succeeded",
  result: RESULT,
  model: "test-model",
});

describe("AI triage in the automation pipeline", () => {
  it("runs after the GitHub step and before Slack, and its result reaches the notification", async () => {
    const o = await newOwner();
    await createRule(db, o, { aiTriage: true });
    const { event } = await createEvent(db, o);
    const { executors, order, slackEvents } = recording(succeeds);

    expect(await processEvent(db, env, attempt(event.id), executors)).toEqual({ kind: "done" });
    expect(order).toEqual(["github", "triage", "slack"]);
    expect(slackEvents[0]).toMatchObject({ aiStatus: "succeeded", aiResult: RESULT });
    const stored = await reloadEvent(db, event.id);
    expect(stored).toMatchObject({
      status: "processed",
      aiStatus: "succeeded",
      aiResult: RESULT,
      aiModel: "test-model",
      aiError: null,
    });
    expect(stored.aiCompletedAt).toBeInstanceOf(Date);
  });

  it("records an AI failure without failing, retrying or blocking the GitHub and Slack steps", async () => {
    const o = await newOwner();
    await createRule(db, o, { aiTriage: true });
    const { event } = await createEvent(db, o);
    const { executors, order, slackEvents } = recording(async () => {
      throw new AiError("Gemini rate limit or quota reached (429 RESOURCE_EXHAUSTED).", 429, true);
    });

    expect(await processEvent(db, env, attempt(event.id), executors)).toEqual({ kind: "done" });
    expect(order).toEqual(["github", "triage", "slack"]);
    expect(slackEvents[0]).toMatchObject({ aiStatus: "failed", aiResult: null });
    expect(await reloadEvent(db, event.id)).toMatchObject({
      status: "processed",
      aiStatus: "failed",
      aiResult: null,
      aiError: expect.stringMatching(/429 RESOURCE_EXHAUSTED/),
    });
    const [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ status: "succeeded", githubStatus: "succeeded", slackStatus: "succeeded" });
  });

  it("is not requested when no matched rule asks for it", async () => {
    const o = await newOwner();
    await createRule(db, o); // aiTriage defaults to false
    const { event } = await createEvent(db, o);
    const { executors, order } = recording(succeeds);
    await processEvent(db, env, attempt(event.id), executors);
    expect(order).toEqual(["github", "slack"]);
    expect((await reloadEvent(db, event.id)).aiStatus).toBeNull();
  });

  it("asks once per event even when several matching rules want it", async () => {
    const o = await newOwner();
    await createRule(db, o, { name: "label", aiTriage: true });
    await createRule(db, o, {
      name: "comment",
      actionType: "add_comment",
      actionValue: "Thanks!",
      aiTriage: true,
    });
    const { event } = await createEvent(db, o);
    const { executors, order, slackEvents } = recording(succeeds);
    await processEvent(db, env, attempt(event.id), executors);
    expect(order.filter((s) => s === "triage")).toHaveLength(1);
    expect(slackEvents).toHaveLength(2);
    expect(slackEvents.every((e) => e.aiResult?.summary === RESULT.summary)).toBe(true);
  });

  it("is not repeated when the job is retried because of a GitHub failure", async () => {
    const o = await newOwner();
    await createRule(db, o, { aiTriage: true });
    const { event } = await createEvent(db, o);
    let githubCalls = 0;
    const { executors, order } = recording(succeeds, async (ctx) => {
      if (++githubCalls === 1) throw new StepError("GitHub returned 502", true);
      return { labelName: ctx.run.actionValue, alreadyApplied: false };
    });

    expect((await processEvent(db, env, attempt(event.id, 1), executors)).kind).toBe("retry");
    expect(order).toEqual(["github", "triage"]); // Slack waits for the GitHub outcome
    expect(await processEvent(db, env, attempt(event.id, 2), executors)).toEqual({ kind: "done" });
    expect(order).toEqual(["github", "triage", "github", "slack"]);
  });
});

describe("production AI executor", () => {
  async function eventWithAiRule() {
    const o = await newOwner();
    await createRule(db, o, { aiTriage: true });
    const { event } = await createEvent(db, o);
    const base = `https://api.github.com/repos/${o.user.githubLogin}/sandbox`;
    return { o, event, base };
  }
  const githubOk = (base: string) => ({
    [`GET ${base}/issues/7/labels`]: () => json([]),
    [`GET ${base}/labels`]: () => json([{ name: "bug" }]),
    [`POST ${base}/issues/7/labels`]: () => json([{ name: "bug" }]),
  });

  it("records the step as skipped, with the reason, when GEMINI_API_KEY is not set", async () => {
    const { event, base } = await eventWithAiRule();
    // Only GitHub is mocked: any request to Gemini would fail and show up as "failed".
    mockFetch(githubOk(base));
    await processEvent(db, env, attempt(event.id), productionExecutors);
    expect(await reloadEvent(db, event.id)).toMatchObject({
      status: "processed",
      aiStatus: "skipped",
      aiError: expect.stringMatching(/GEMINI_API_KEY is not set/),
    });
  });

  it("labels the issue, asks Gemini, then posts a Slack message that includes the suggestion", async () => {
    const { event, base } = await eventWithAiRule();
    const model = "gemini-3.1-flash-lite";
    const gemini = `${GEMINI_API_URL}/models/${model}:generateContent`;
    const { calls } = mockFetch({
      ...githubOk(base),
      [`POST ${gemini}`]: () =>
        json({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ ...RESULT, summary: "Crash <!channel> on login" }) }],
              },
              finishReason: "STOP",
            },
          ],
        }),
      [`POST ${DEFAULT_HOOK}`]: () => new Response("ok", { status: 200 }),
    });
    const configured = { ...env, GEMINI_API_KEY: KEY, GEMINI_MODEL: model, SLACK_WEBHOOK_URL: DEFAULT_HOOK };

    expect(await processEvent(db, configured, attempt(event.id), productionExecutors)).toEqual({
      kind: "done",
    });

    const index = (host: string, method = "POST") =>
      calls.findIndex((c) => c.method === method && c.url.hostname === host);
    expect(index("api.github.com")).toBeGreaterThan(-1);
    expect(index("api.github.com")).toBeLessThan(index("generativelanguage.googleapis.com"));
    expect(index("generativelanguage.googleapis.com")).toBeLessThan(index("hooks.slack.com"));

    const slack = JSON.stringify(JSON.parse(calls[index("hooks.slack.com")]!.body).blocks);
    expect(slack).toContain("AI triage (suggestion only)");
    expect(slack).toContain("Suggested label: `bug`");
    // Model output is escaped like any other untrusted text.
    expect(slack).toContain("&lt;!channel&gt;");
    expect(slack).not.toContain("<!channel>");

    expect(await reloadEvent(db, event.id)).toMatchObject({ aiStatus: "succeeded", aiModel: model });
    const [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ githubStatus: "succeeded", slackStatus: "succeeded" });
  });

  it("enforces the per-account hourly limit before calling Gemini", async () => {
    const o = await newOwner();
    const { event } = await createEvent(db, o);
    await db
      .insert(rateLimits)
      .values({ key: `ai:${o.user.id}`, windowStart: new Date(), count: AI_TRIAGE_HOURLY_LIMIT });
    const { calls } = mockFetch({});
    const err = await runAiTriage({
      db,
      env: { ...env, GEMINI_API_KEY: KEY },
      event,
      subject: issueSubject(),
      repository: o.repo,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StepError);
    expect((err as StepError).message).toContain(
      `AI triage limit reached (${AI_TRIAGE_HOURLY_LIMIT} per hour per account)`,
    );
    expect((err as StepError).retryable).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("uses the default model when GEMINI_MODEL is not set", async () => {
    const o = await newOwner();
    const { event } = await createEvent(db, o);
    const { calls } = mockFetch({
      [`POST ${GEMINI_API_URL}/models/${DEFAULT_GEMINI_MODEL}:generateContent`]: () =>
        json({
          candidates: [{ content: { parts: [{ text: JSON.stringify(RESULT) }] }, finishReason: "STOP" }],
        }),
    });
    const out = await runAiTriage({
      db,
      env: { ...env, GEMINI_API_KEY: KEY },
      event,
      subject: issueSubject(),
      repository: o.repo,
    });
    expect(out).toEqual({ status: "succeeded", result: RESULT, model: DEFAULT_GEMINI_MODEL });
    expect(calls).toHaveLength(1);
  });
});

describe("dashboard and manual retry", () => {
  const deps = (): AuthDeps => ({ db, env });
  const detail = (cookie: string, id: string) =>
    getEventHandler(apiRequest(env, "GET", `/api/events/${id}`, { cookie }), deps(), id);
  const retry = (cookie: string, id: string) =>
    retryEventHandler(apiRequest(env, "POST", `/api/events/${id}/retry`, { cookie }), deps(), id, vi.fn());

  it("shows the triage on the event detail, and nothing for events without one", async () => {
    const o = await newOwner();
    await createRule(db, o, { aiTriage: true });
    const { event } = await createEvent(db, o);
    await processEvent(db, env, attempt(event.id), recording(succeeds).executors);
    const body = await (await detail(o.cookie, event.id)).json();
    expect(body.event.ai).toMatchObject({
      status: "succeeded",
      result: RESULT,
      model: "test-model",
      error: null,
    });

    const { event: plain } = await createEvent(db, o, {
      subject: issueSubject({ title: "Question: docs?" }),
    });
    expect((await (await detail(o.cookie, plain.id)).json()).event.ai).toBeNull();
  });

  it("retries a failed triage without repeating steps that succeeded", async () => {
    const o = await newOwner();
    await createRule(db, o, { aiTriage: true });
    const { event } = await createEvent(db, o);
    await processEvent(
      db,
      env,
      attempt(event.id),
      recording(async () => {
        throw new AiError("Gemini API error 503 UNAVAILABLE: overloaded", 503, true);
      }).executors,
    );
    expect((await reloadEvent(db, event.id)).aiStatus).toBe("failed");

    expect((await retry(o.cookie, event.id)).status).toBe(202);
    expect(await reloadEvent(db, event.id)).toMatchObject({
      status: "processing",
      aiStatus: null,
      aiError: null,
    });

    const second = recording(succeeds);
    await processEvent(db, env, attempt(event.id), second.executors);
    expect(second.order).toEqual(["triage"]); // the label and the Slack message are not repeated
    expect(await reloadEvent(db, event.id)).toMatchObject({ status: "processed", aiStatus: "succeeded" });

    const nothing = await retry(o.cookie, event.id);
    expect(nothing.status).toBe(409);
    expect((await nothing.json()).error.code).toBe("nothing_to_retry");
  });
});

describe("structured logs", () => {
  it("trace one delivery end to end, with durations, and never contain the key or issue text", async () => {
    const o = await newOwner();
    await createRule(db, o, { aiTriage: true });
    const { event } = await createEvent(db, o, {
      subject: issueSubject({ body: "Reproduction notes that must stay out of logs." }),
    });
    const base = `https://api.github.com/repos/${o.user.githubLogin}/sandbox`;
    mockFetch({
      [`GET ${base}/issues/7/labels`]: () => json([]),
      [`GET ${base}/labels`]: () => json([{ name: "bug" }]),
      [`POST ${base}/issues/7/labels`]: () => json([{ name: "bug" }]),
      // An error body that echoes the key: it must be scrubbed before storage and logs.
      [`POST ${GEMINI_API_URL}/models/${DEFAULT_GEMINI_MODEL}:generateContent`]: () =>
        json({ error: { code: 400, message: `API key not valid: ${KEY}`, status: "INVALID_ARGUMENT" } }, 400),
    });
    const lines: string[] = [];
    const capture = (line: unknown) => void lines.push(String(line));
    const spies = [
      vi.spyOn(console, "log").mockImplementation(capture),
      vi.spyOn(console, "warn").mockImplementation(capture),
      vi.spyOn(console, "error").mockImplementation(capture),
    ];
    process.env.LOG_IN_TESTS = "1";
    try {
      await processEvent(db, { ...env, GEMINI_API_KEY: KEY }, attempt(event.id), productionExecutors);
    } finally {
      delete process.env.LOG_IN_TESTS;
      spies.forEach((s) => s.mockRestore());
    }

    const logs = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    const pipeline = [
      "rules_evaluated",
      "rule_matched",
      "github_action_succeeded",
      "ai_triage_failed",
      "slack_notification_skipped",
      "event_processed",
    ];
    const steps = logs.filter((l) => pipeline.includes(String(l.event)));
    expect(steps.map((l) => l.event)).toEqual(pipeline);
    for (const l of steps) {
      expect(l).toMatchObject({
        eventId: event.id,
        deliveryId: event.deliveryId,
        repository: o.repo.fullName,
        attempt: 1,
      });
    }
    for (const name of ["github_action_succeeded", "ai_triage_failed", "event_processed"]) {
      expect(steps.find((l) => l.event === name)?.durationMs).toEqual(expect.any(Number));
    }
    const all = lines.join("\n");
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("Reproduction notes");
    expect((await reloadEvent(db, event.id)).aiError).not.toContain(KEY);
  });
});

describe("rules API: aiTriage", () => {
  const depsWith = (overrides: Partial<Env> = {}): AuthDeps => ({ db, env: { ...env, ...overrides } });
  const rule = (repositoryId: string, extra: Record<string, unknown> = {}) => ({
    repositoryId,
    name: "Bug issue automation",
    eventType: "issues",
    actionType: "add_label",
    actionValue: "bug",
    ...extra,
  });

  it("is off by default, can be switched on, and the list says whether AI is available", async () => {
    const o = await newOwner();
    const created = await createRuleHandler(
      apiRequest(env, "POST", "/api/rules", { cookie: o.cookie, body: rule(o.repo.id) }),
      depsWith(),
    );
    expect(created.status).toBe(201);
    const { rule: saved } = await created.json();
    expect(saved.aiTriage).toBe(false);

    const patched = await updateRuleHandler(
      apiRequest(env, "PATCH", `/api/rules/${saved.id}`, { cookie: o.cookie, body: { aiTriage: true } }),
      depsWith(),
      saved.id,
    );
    expect((await patched.json()).rule.aiTriage).toBe(true);

    const list = (overrides: Partial<Env>) =>
      listRulesHandler(apiRequest(env, "GET", "/api/rules", { cookie: o.cookie }), depsWith(overrides));
    expect((await (await list({})).json()).aiAvailable).toBe(false);
    const withKey = await (await list({ GEMINI_API_KEY: KEY })).text();
    expect(JSON.parse(withKey).aiAvailable).toBe(true);
    expect(withKey).not.toContain(KEY);
  });

  it("rejects a non-boolean aiTriage", async () => {
    const o = await newOwner();
    const res = await createRuleHandler(
      apiRequest(env, "POST", "/api/rules", { cookie: o.cookie, body: rule(o.repo.id, { aiTriage: "yes" }) }),
      depsWith(),
    );
    expect(res.status).toBe(400);
  });
});
