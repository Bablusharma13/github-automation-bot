import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db";
import { jobs, repositories, webhookEvents } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import { ingestGitHubDelivery, MAX_WEBHOOK_BODY_BYTES } from "@/server/webhooks/ingest";
import { signPayload } from "@/server/webhooks/signature";
import { createSignedInUser } from "../helpers/auth";
import { createTestDb } from "../helpers/db";

const REPO_ID = 4242;
const HOOK_ID = 777;
let db: Db;
let close: () => Promise<void>;
let env: Env;
let ownerId: string;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv();
  const owner = await createSignedInUser(db, env, "hook-owner");
  ownerId = owner.user.id;
  await db.insert(repositories).values({
    userId: ownerId,
    githubRepoId: REPO_ID,
    owner: "hook-owner",
    name: "sandbox",
    fullName: "hook-owner/sandbox",
    htmlUrl: "https://github.com/hook-owner/sandbox",
    webhookId: HOOK_ID,
    active: true,
  });
});
afterAll(async () => close());

function issuePayload(
  overrides: { repoId?: number; action?: string; title?: string; body?: string | null } = {},
) {
  return {
    action: overrides.action ?? "opened",
    issue: {
      number: 12,
      title: overrides.title ?? "Bug: login fails after refresh",
      body: overrides.body === undefined ? "Steps to reproduce…" : overrides.body,
      html_url: "https://github.com/hook-owner/sandbox/issues/12",
      state: "open",
      user: { login: "reporter" },
      labels: [{ name: "triage" }],
    },
    repository: { id: overrides.repoId ?? REPO_ID, full_name: "hook-owner/sandbox" },
    sender: { login: "reporter" },
  };
}

function prPayload() {
  return {
    action: "opened",
    pull_request: {
      number: 5,
      title: "Fix login bug",
      body: null,
      html_url: "https://github.com/hook-owner/sandbox/pull/5",
      state: "open",
      user: { login: "contributor" },
      labels: [],
    },
    repository: { id: REPO_ID, full_name: "hook-owner/sandbox" },
    sender: { login: "contributor" },
  };
}

/** Sends a delivery exactly as GitHub would; every header/body can be tampered with. */
function deliver(
  opts: {
    event?: string | null;
    payload?: unknown;
    raw?: string | Buffer;
    deliveryId?: string | null;
    secret?: string;
    signature?: string | null;
    hookId?: string | null;
    contentType?: string | null;
  } = {},
) {
  const rawBody = Buffer.isBuffer(opts.raw)
    ? opts.raw
    : Buffer.from(opts.raw ?? JSON.stringify(opts.payload ?? issuePayload()), "utf8");
  const headers = new Headers();
  const set = (k: string, v: string | null | undefined, fallback: string) => {
    if (v !== null) headers.set(k, v ?? fallback);
  };
  set("x-github-event", opts.event, "issues");
  set("x-github-delivery", opts.deliveryId, randomUUID());
  set("x-github-hook-id", opts.hookId, String(HOOK_ID));
  set("content-type", opts.contentType, "application/json");
  set("x-hub-signature-256", opts.signature, signPayload(opts.secret ?? env.GITHUB_WEBHOOK_SECRET, rawBody));
  headers.set("user-agent", "GitHub-Hookshot/test");
  return ingestGitHubDelivery(db, env, { headers, rawBody });
}

async function eventRow(deliveryId: string) {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.deliveryId, deliveryId));
  return row;
}
async function jobCount(eventId: string) {
  return (await db.select().from(jobs).where(eq(jobs.webhookEventId, eventId))).length;
}

describe("signature verification", () => {
  it("accepts a valid signature, persists the event and queues exactly one job", async () => {
    const deliveryId = randomUUID();
    const res = await deliver({ deliveryId });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ ok: true, status: "queued" });

    const row = await eventRow(deliveryId);
    expect(row).toMatchObject({
      eventType: "issues",
      action: "opened",
      status: "received",
      userId: ownerId,
      githubRepoId: REPO_ID,
      repoFullName: "hook-owner/sandbox",
      senderLogin: "reporter",
    });
    expect(row!.subject).toEqual({
      kind: "issue",
      number: 12,
      title: "Bug: login fails after refresh",
      body: "Steps to reproduce…",
      url: "https://github.com/hook-owner/sandbox/issues/12",
      state: "open",
      author: "reporter",
      labels: ["triage"],
    });
    expect(await jobCount(row!.id)).toBe(1);
  });

  it("rejects an invalid signature (wrong secret) and stores nothing", async () => {
    const deliveryId = randomUUID();
    const res = await deliver({ deliveryId, secret: "attacker-guess-0123456789" });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "invalid_signature" } });
    expect(await eventRow(deliveryId)).toBeUndefined();
  });

  it("rejects a missing signature and stores nothing", async () => {
    const deliveryId = randomUUID();
    const res = await deliver({ deliveryId, signature: null });
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: { code: "missing_signature" } });
    expect(await eventRow(deliveryId)).toBeUndefined();
  });

  it("rejects a body tampered with after signing", async () => {
    const original = JSON.stringify(issuePayload({ title: "Harmless" }));
    const tampered = JSON.stringify(issuePayload({ title: "Bug: injected" }));
    const deliveryId = randomUUID();
    const res = await deliver({
      deliveryId,
      raw: tampered,
      signature: signPayload(env.GITHUB_WEBHOOK_SECRET, original),
    });
    expect(res.status).toBe(401);
    expect(await eventRow(deliveryId)).toBeUndefined();
  });

  it("verifies over the raw bytes (whitespace and unicode preserved), not re-serialised JSON", async () => {
    const raw = `{ "action":"opened",  "issue": {"number": 12, "title": "Bug: ümlaut — 日本語", "body": null,
      "html_url": "https://github.com/hook-owner/sandbox/issues/12", "state": "open", "user": {"login": "r"}, "labels": []},
      "repository": {"id": ${REPO_ID}, "full_name": "hook-owner/sandbox"}, "sender": {"login": "r"} }`;
    const deliveryId = randomUUID();
    const res = await deliver({ deliveryId, raw });
    expect(res.status).toBe(202);
    expect((await eventRow(deliveryId))!.subject!.title).toBe("Bug: ümlaut — 日本語");
  });
});

describe("replay / duplicate protection", () => {
  it("records a redelivered delivery id once and never queues a second job", async () => {
    const deliveryId = randomUUID();
    const first = await deliver({ deliveryId });
    const second = await deliver({ deliveryId });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body).toEqual({ ok: true, status: "duplicate" });
    const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.deliveryId, deliveryId));
    expect(rows).toHaveLength(1);
    expect(await jobCount(rows[0]!.id)).toBe(1);
  });

  it("stays at one event and one job when the same delivery arrives concurrently", async () => {
    const deliveryId = randomUUID();
    const results = await Promise.all([
      deliver({ deliveryId }),
      deliver({ deliveryId }),
      deliver({ deliveryId }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 200, 202]);
    const rows = await db.select().from(webhookEvents).where(eq(webhookEvents.deliveryId, deliveryId));
    expect(rows).toHaveLength(1);
    expect(await jobCount(rows[0]!.id)).toBe(1);
  });
});

describe("event types", () => {
  it("queues supported pull_request events with the PR as subject", async () => {
    const deliveryId = randomUUID();
    const res = await deliver({ deliveryId, event: "pull_request", payload: prPayload() });
    expect(res.status).toBe(202);
    const row = await eventRow(deliveryId);
    expect(row!.subject).toMatchObject({ kind: "pull_request", number: 5, body: "", author: "contributor" });
    expect(await jobCount(row!.id)).toBe(1);
  });

  it("acknowledges and records unsupported events without queuing work", async () => {
    const deliveryId = randomUUID();
    const res = await deliver({
      deliveryId,
      event: "push",
      payload: { ref: "refs/heads/main", repository: { id: REPO_ID, full_name: "hook-owner/sandbox" } },
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, status: "ignored", reason: "unsupported_event" });
    const row = await eventRow(deliveryId);
    expect(row).toMatchObject({ status: "ignored", ignoreReason: "unsupported_event" });
    expect(await jobCount(row!.id)).toBe(0);
  });

  it("records GitHub's ping (sent when a webhook is created) as ignored", async () => {
    const deliveryId = randomUUID();
    const res = await deliver({
      deliveryId,
      event: "ping",
      payload: {
        zen: "Keep it logically awesome.",
        hook_id: HOOK_ID,
        repository: { id: REPO_ID, full_name: "hook-owner/sandbox" },
      },
    });
    expect(res.body).toEqual({ ok: true, status: "ignored", reason: "ping" });
    expect((await eventRow(deliveryId))!.userId).toBe(ownerId);
  });

  it("ignores events for repositories that are not connected and keeps none of their content", async () => {
    const deliveryId = randomUUID();
    const res = await deliver({ deliveryId, payload: issuePayload({ repoId: 999_999 }) });
    expect(res.body).toEqual({ ok: true, status: "ignored", reason: "repository_not_connected" });
    const row = await eventRow(deliveryId);
    expect(row).toMatchObject({ userId: null, subject: null, status: "ignored" });
    expect(await jobCount(row!.id)).toBe(0);
  });

  it("ignores deliveries from a hook other than the one we installed (prevents double processing)", async () => {
    const deliveryId = randomUUID();
    const res = await deliver({ deliveryId, hookId: "123456" });
    expect(res.body).toEqual({ ok: true, status: "ignored", reason: "unknown_hook" });
    expect(await jobCount((await eventRow(deliveryId))!.id)).toBe(0);
  });
});

describe("request validation (after a valid signature)", () => {
  it("rejects malformed JSON", async () => {
    const res = await deliver({ raw: "{not json" });
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: "malformed_payload" } });
  });

  it("rejects a supported event missing required fields", async () => {
    const deliveryId = randomUUID();
    const res = await deliver({
      deliveryId,
      payload: { action: "opened", repository: { id: REPO_ID, full_name: "x/y" } },
    });
    expect(res.status).toBe(400);
    expect(await eventRow(deliveryId)).toBeUndefined();
  });

  it("rejects missing or malformed delivery ids and event names", async () => {
    expect((await deliver({ deliveryId: null })).status).toBe(400);
    expect((await deliver({ deliveryId: "'; drop table webhook_events; --" })).status).toBe(400);
    expect((await deliver({ event: null })).status).toBe(400);
    expect((await deliver({ event: "Issues<script>" })).status).toBe(400);
  });

  it("rejects non-JSON content types (form-encoded webhooks are not supported)", async () => {
    const res = await deliver({ contentType: "application/x-www-form-urlencoded" });
    expect(res.status).toBe(415);
  });

  it("rejects oversized bodies before verifying anything", async () => {
    const res = await deliver({ raw: Buffer.alloc(MAX_WEBHOOK_BODY_BYTES + 1, 32) });
    expect(res.status).toBe(413);
  });
});
