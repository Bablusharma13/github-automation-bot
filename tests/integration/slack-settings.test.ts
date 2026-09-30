import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "@/server/auth/handlers";
import { sendSlackNotification } from "@/server/automation/slack-executor";
import { productionExecutors } from "@/server/automation/executors";
import { processEvent } from "@/server/automation/process-event";
import { encryptSecret } from "@/server/crypto";
import type { Db } from "@/server/db";
import { users } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import {
  clearSlackSettingsHandler,
  getSlackSettingsHandler,
  saveSlackSettingsHandler,
  testSlackHandler,
} from "@/server/slack/handlers";
import { apiRequest } from "../helpers/auth";
import { createTestDb } from "../helpers/db";
import { json, mockFetch } from "../helpers/fetch-mock";
import { createEvent, createOwnerWithRepo, createRule, runsFor } from "../helpers/fixtures";

const USER_HOOK = "https://hooks.slack.com/services/TUSER/BUSER/useruseruser";
const DEFAULT_HOOK = "https://hooks.slack.com/services/TDEF/BDEF/defaultdefault";

let db: Db;
let close: () => Promise<void>;
let env: Env;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv(); // SLACK_WEBHOOK_URL is unset in tests
});
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());

const newOwner = () => createOwnerWithRepo(db, env, `slack-owner-${++seq}`);
const depsWith = (overrides: Partial<Env> = {}): AuthDeps => ({ db, env: { ...env, ...overrides } });

const get = (cookie: string, deps = depsWith()) =>
  getSlackSettingsHandler(apiRequest(env, "GET", "/api/settings/slack", { cookie }), deps);
const save = (cookie: string, body: unknown, deps = depsWith(), origin?: string) =>
  saveSlackSettingsHandler(apiRequest(env, "PUT", "/api/settings/slack", { cookie, body, origin }), deps);
const clear = (cookie: string, deps = depsWith()) =>
  clearSlackSettingsHandler(apiRequest(env, "DELETE", "/api/settings/slack", { cookie }), deps);
const test = (cookie: string, deps = depsWith()) =>
  testSlackHandler(apiRequest(env, "POST", "/api/settings/slack/test", { cookie }), deps);

describe("Slack settings API", () => {
  it("saves the webhook encrypted and never returns it", async () => {
    const o = await newOwner();
    expect(await (await get(o.cookie)).json()).toEqual({
      source: "none",
      defaultAvailable: false,
      problem: null,
    });

    const res = await save(o.cookie, { webhookUrl: `  ${USER_HOOK}  ` });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("hooks.slack.com");
    expect(JSON.parse(body)).toMatchObject({ source: "user" });

    const [row] = await db.select().from(users).where(eq(users.id, o.user.id));
    expect(row!.slackWebhookUrlEnc).toBeTruthy();
    expect(row!.slackWebhookUrlEnc).not.toContain("hooks.slack.com");
    expect(await (await get(o.cookie)).text()).not.toContain("hooks.slack.com");
  });

  it("rejects anything that is not a Slack Incoming Webhook URL", async () => {
    const o = await newOwner();
    for (const webhookUrl of [
      "https://evil.example/services/x",
      "http://hooks.slack.com/services/T/B/X",
      "",
      42,
    ]) {
      const res = await save(o.cookie, { webhookUrl });
      expect(res.status, String(webhookUrl)).toBe(400);
    }
    expect((await save(o.cookie, { webhookUrl: USER_HOOK, extra: true })).status).toBe(400);
  });

  it("requires a session and a same-origin request", async () => {
    const o = await newOwner();
    expect(
      (await getSlackSettingsHandler(apiRequest(env, "GET", "/api/settings/slack"), depsWith())).status,
    ).toBe(401);
    expect((await save(o.cookie, { webhookUrl: USER_HOOK }, depsWith(), "https://evil.example")).status).toBe(
      403,
    );
    const [row] = await db.select().from(users).where(eq(users.id, o.user.id));
    expect(row!.slackWebhookUrlEnc).toBeNull();
  });

  it("only ever changes the caller's own settings", async () => {
    const a = await newOwner();
    const b = await newOwner();
    await save(b.cookie, { webhookUrl: USER_HOOK });
    await clear(a.cookie);
    const [rowB] = await db.select().from(users).where(eq(users.id, b.user.id));
    expect(rowB!.slackWebhookUrlEnc).toBeTruthy();
  });

  it("falls back to the deployment default after removing the user's webhook", async () => {
    const o = await newOwner();
    const deps = depsWith({ SLACK_WEBHOOK_URL: DEFAULT_HOOK });
    await save(o.cookie, { webhookUrl: USER_HOOK }, deps);
    expect(await (await clear(o.cookie, deps)).json()).toMatchObject({
      source: "default",
      defaultAvailable: true,
    });
  });

  it("sends a real test message to the effective webhook and reports Slack's errors", async () => {
    const o = await newOwner();
    expect((await test(o.cookie)).status).toBe(409); // nothing configured
    await save(o.cookie, { webhookUrl: USER_HOOK });

    const slack = mockFetch({ [`POST ${USER_HOOK}`]: () => new Response("ok", { status: 200 }) });
    const ok = await test(o.cookie);
    expect(ok.status).toBe(200);
    expect(JSON.parse(slack.calls[0]!.body).text).toContain(o.user.githubLogin);

    vi.unstubAllGlobals();
    mockFetch({ [`POST ${USER_HOOK}`]: () => new Response("no_service", { status: 404 }) });
    const bad = await test(o.cookie);
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.message).toMatch(/no_service/);
  });
});

describe("Slack step of an automation run", () => {
  async function eventWithRule() {
    const o = await newOwner();
    await createRule(db, o);
    const { event } = await createEvent(db, o);
    const base = `https://api.github.com/repos/${o.user.githubLogin}/sandbox`;
    return { o, event, base };
  }
  const githubOk = (base: string) => ({
    [`GET ${base}/issues/7/labels`]: () => json([]),
    [`GET ${base}/labels`]: () => json([{ name: "bug" }]),
    [`POST ${base}/issues/7/labels`]: () => json([{ name: "bug" }]),
  });

  it("is skipped with a reason when no webhook is configured", async () => {
    const { event, base } = await eventWithRule();
    mockFetch(githubOk(base));
    await processEvent(
      db,
      env,
      { webhookEventId: event.id, attempt: 1, isFinalAttempt: false },
      productionExecutors,
    );
    const [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ status: "succeeded", slackStatus: "skipped" });
    expect(run!.slackError).toMatch(/No Slack webhook is configured/);
  });

  it("posts the outcome to the user's webhook, preferring it over the default", async () => {
    const { o, event, base } = await eventWithRule();
    await db
      .update(users)
      .set({ slackWebhookUrlEnc: encryptSecret(USER_HOOK, env.TOKEN_ENCRYPTION_KEY) })
      .where(eq(users.id, o.user.id));
    const calls = mockFetch({
      ...githubOk(base),
      [`POST ${USER_HOOK}`]: () => new Response("ok", { status: 200 }),
      [`POST ${DEFAULT_HOOK}`]: () => new Response("ok", { status: 200 }),
    });
    const withDefault = { ...env, SLACK_WEBHOOK_URL: DEFAULT_HOOK };
    await processEvent(
      db,
      withDefault,
      { webhookEventId: event.id, attempt: 1, isFinalAttempt: false },
      productionExecutors,
    );
    const [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({
      status: "succeeded",
      githubStatus: "succeeded",
      slackStatus: "succeeded",
      slackAttempts: 1,
    });
    const slackCalls = calls.calls.filter((c) => c.url.hostname === "hooks.slack.com");
    expect(slackCalls.map((c) => c.url.pathname)).toEqual(["/services/TUSER/BUSER/useruseruser"]);
    expect(JSON.parse(slackCalls[0]!.body).text).toMatch(/Added label `bug` on issue #7/);
  });

  it("uses the deployment default when the user has none", async () => {
    const { event, base } = await eventWithRule();
    const calls = mockFetch({
      ...githubOk(base),
      [`POST ${DEFAULT_HOOK}`]: () => new Response("ok", { status: 200 }),
    });
    await processEvent(
      db,
      { ...env, SLACK_WEBHOOK_URL: DEFAULT_HOOK },
      { webhookEventId: event.id, attempt: 1, isFinalAttempt: false },
      productionExecutors,
    );
    expect(calls.calls.some((c) => c.url.pathname === "/services/TDEF/BDEF/defaultdefault")).toBe(true);
  });

  it("retries a Slack outage without repeating the GitHub label", async () => {
    const { o, event, base } = await eventWithRule();
    await db
      .update(users)
      .set({ slackWebhookUrlEnc: encryptSecret(USER_HOOK, env.TOKEN_ENCRYPTION_KEY) })
      .where(eq(users.id, o.user.id));
    let slackCalls = 0;
    let labelPosts = 0;
    mockFetch({
      [`GET ${base}/issues/7/labels`]: () => json([]),
      [`GET ${base}/labels`]: () => json([{ name: "bug" }]),
      [`POST ${base}/issues/7/labels`]: () => {
        labelPosts++;
        return json([{ name: "bug" }]);
      },
      [`POST ${USER_HOOK}`]: () =>
        ++slackCalls === 1
          ? new Response("service unavailable", { status: 503 })
          : new Response("ok", { status: 200 }),
    });
    const first = await processEvent(
      db,
      env,
      { webhookEventId: event.id, attempt: 1, isFinalAttempt: false },
      productionExecutors,
    );
    expect(first.kind).toBe("retry");
    const second = await processEvent(
      db,
      env,
      { webhookEventId: event.id, attempt: 2, isFinalAttempt: false },
      productionExecutors,
    );
    expect(second.kind).toBe("done");
    expect(labelPosts).toBe(1);
    expect(slackCalls).toBe(2);
    const [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ githubStatus: "succeeded", slackStatus: "succeeded", slackAttempts: 2 });
  });

  it("reports an unreadable saved webhook instead of silently using the default", async () => {
    const { o, event } = await eventWithRule();
    await db
      .update(users)
      .set({ slackWebhookUrlEnc: encryptSecret(USER_HOOK, Buffer.alloc(32, 3).toString("base64")) })
      .where(eq(users.id, o.user.id));
    const out = await sendSlackNotification({
      db,
      env: { ...env, SLACK_WEBHOOK_URL: DEFAULT_HOOK },
      run: {} as never,
      event,
      subject: event.subject!,
      repository: o.repo,
    });
    expect(out).toEqual({
      status: "skipped",
      reason: "The saved Slack webhook could not be read. Save it again in Settings.",
    });
  });
});
