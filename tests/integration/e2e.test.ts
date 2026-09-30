import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DEFAULT_GEMINI_MODEL, GEMINI_API_URL } from "@/server/ai/gemini";
import type { Repository } from "@/server/db/schema";
import type { Db } from "@/server/db";
import { getEnv, type Env } from "@/server/env";
import { getEventHandler, listEventsHandler } from "@/server/events/handlers";
import { drainJobs } from "@/server/jobs/worker";
import { ingestGitHubDelivery } from "@/server/webhooks/ingest";
import { signPayload } from "@/server/webhooks/signature";
import { apiRequest } from "../helpers/auth";
import { createTestDb } from "../helpers/db";
import { json, mockFetch } from "../helpers/fetch-mock";
import { createOwnerWithRepo, createRule } from "../helpers/fixtures";

const SLACK_HOOK = "https://hooks.slack.com/services/TE2E/BE2E/e2ee2ee2ee2e";
const GEMINI_KEY = "test-gemini-key-e2e-0123456789";
const GEMINI = `${GEMINI_API_URL}/models/${DEFAULT_GEMINI_MODEL}:generateContent`;

let db: Db;
let close: () => Promise<void>;
let env: Env;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv();
});
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());

/** A delivery exactly as GitHub sends it: raw JSON body, signature and delivery headers. */
function delivery(repo: Repository, deliveryId: string, payload: unknown) {
  const rawBody = Buffer.from(JSON.stringify(payload), "utf8");
  const headers = new Headers({
    "content-type": "application/json",
    "user-agent": "GitHub-Hookshot/e2e",
    "x-github-event": "issues",
    "x-github-delivery": deliveryId,
    "x-github-hook-id": String(repo.webhookId),
    "x-hub-signature-256": signPayload(env.GITHUB_WEBHOOK_SECRET, rawBody),
  });
  return { headers, rawBody };
}

describe("end to end (external APIs mocked at the network boundary)", () => {
  it("GitHub event → webhook → DB → job → rule → GitHub label → AI → Slack → dashboard log", async () => {
    const o = await createOwnerWithRepo(db, env, "e2e-owner");
    await createRule(db, o, { aiTriage: true }); // "bug" in the title → add label bug, notify Slack
    const configured: Env = { ...env, SLACK_WEBHOOK_URL: SLACK_HOOK, GEMINI_API_KEY: GEMINI_KEY };
    const repoApi = `https://api.github.com/repos/${o.repo.fullName}`;
    const { calls } = mockFetch({
      [`GET ${repoApi}/issues/12/labels`]: () => json([]),
      [`GET ${repoApi}/labels`]: () => json([{ name: "bug" }, { name: "enhancement" }]),
      [`POST ${repoApi}/issues/12/labels`]: () => json([{ name: "bug" }]),
      [`POST ${GEMINI}`]: () =>
        json({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: "Signing in fails after the page is refreshed.",
                      suggestedLabel: "bug",
                      priority: "high",
                    }),
                  },
                ],
              },
              finishReason: "STOP",
            },
          ],
        }),
      [`POST ${SLACK_HOOK}`]: () => new Response("ok", { status: 200 }),
    });
    const deliveryId = randomUUID();
    const payload = {
      action: "opened",
      issue: {
        number: 12,
        title: "Bug: login fails after refresh",
        body: "Steps: sign in, refresh the page, you are signed out.",
        html_url: `https://github.com/${o.repo.fullName}/issues/12`,
        state: "open",
        user: { login: "reporter" },
        labels: [],
      },
      repository: { id: o.repo.githubRepoId, full_name: o.repo.fullName },
      sender: { login: "reporter" },
    };

    // Webhook: signature verified, event + job stored in one transaction, then acknowledged.
    // Nothing external happens before GitHub gets its answer.
    const ack = await ingestGitHubDelivery(db, configured, delivery(o.repo, deliveryId, payload));
    expect(ack).toMatchObject({ status: 202, body: { status: "queued" } });
    expect(calls).toHaveLength(0);

    // Worker (what the route's after() runs): job → rule → GitHub → AI → Slack.
    const stats = await drainJobs(db, configured, { budgetMs: 15_000 });
    expect(stats).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, failed: 0 });

    const post = (host: string) => calls.findIndex((c) => c.method === "POST" && c.url.hostname === host);
    const labelWrite = calls[post("api.github.com")]!;
    expect(JSON.parse(labelWrite.body)).toEqual({ labels: ["bug"] });
    expect(labelWrite.headers.get("authorization")).toMatch(/^Bearer /);
    expect(post("api.github.com")).toBeLessThan(post("generativelanguage.googleapis.com"));
    expect(post("generativelanguage.googleapis.com")).toBeLessThan(post("hooks.slack.com"));
    const slack = JSON.parse(calls[post("hooks.slack.com")]!.body);
    expect(slack.text).toContain("Added label `bug` on issue #12");
    expect(JSON.stringify(slack.blocks)).toContain("AI triage (suggestion only)");

    // Dashboard: the owner's activity log shows the whole story.
    const listed = await listEventsHandler(apiRequest(env, "GET", "/api/events", { cookie: o.cookie }), {
      db,
      env: configured,
    });
    const [event] = (await listed.json()).events;
    expect(event).toMatchObject({
      deliveryId,
      status: "processed",
      job: { status: "succeeded", attempts: 1 },
      ai: { status: "succeeded", result: { suggestedLabel: "bug", priority: "high" } },
      runs: [
        {
          ruleName: "Bug issue automation",
          status: "succeeded",
          githubStatus: "succeeded",
          githubResult: { labelName: "bug", alreadyApplied: false },
          slackStatus: "succeeded",
        },
      ],
    });
    const detail = await getEventHandler(
      apiRequest(env, "GET", `/api/events/${event.id}`, { cookie: o.cookie }),
      { db, env: configured },
      event.id,
    );
    expect((await detail.json()).event.bodyPreview).toContain("refresh the page");

    // GitHub redelivers the same delivery: acknowledged as a duplicate, no new work.
    const externalCalls = calls.length;
    const again = await ingestGitHubDelivery(db, configured, delivery(o.repo, deliveryId, payload));
    expect(again).toMatchObject({ status: 200, body: { status: "duplicate" } });
    expect((await drainJobs(db, configured, { budgetMs: 5_000 })).claimed).toBe(0);
    expect(calls).toHaveLength(externalCalls);
  });
});
