import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { productionExecutors } from "@/server/automation/executors";
import { commentBody, commentMarker } from "@/server/automation/github-executor";
import { processEvent } from "@/server/automation/process-event";
import type { Db } from "@/server/db";
import { automationRuns, users, webhookEvents } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import { createTestDb } from "../helpers/db";
import { json, mockFetch, type RecordedRequest } from "../helpers/fetch-mock";
import { createEvent, createOwnerWithRepo, createRule, reloadEvent, runsFor } from "../helpers/fixtures";

let db: Db;
let close: () => Promise<void>;
let env: Env;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv();
});
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());

async function setup(rule: Parameters<typeof createRule>[2] = {}) {
  const login = `gx-owner-${++seq}`;
  const o = await createOwnerWithRepo(db, env, login);
  await createRule(db, o, rule);
  const { event } = await createEvent(db, o);
  const base = `https://api.github.com/repos/${login}/sandbox`;
  return { o, event, base, login };
}

const run = (eventId: string, attempt = 1) =>
  processEvent(db, env, { webhookEventId: eventId, attempt, isFinalAttempt: false }, productionExecutors);

const posts = (calls: RecordedRequest[]) => calls.filter((c) => c.method === "POST");

describe("add_label", () => {
  it("adds an existing repository label using its canonical name, with the owner's token", async () => {
    const { o, event, base } = await setup();
    const gh = mockFetch({
      [`GET ${base}/issues/7/labels`]: () => json([{ name: "triage" }]),
      [`GET ${base}/labels`]: () => json([{ name: "Bug" }, { name: "docs" }]),
      [`POST ${base}/issues/7/labels`]: () => json([{ name: "triage" }, { name: "Bug" }]),
    });

    expect(await run(event.id)).toEqual({ kind: "done" });
    const post = posts(gh.calls)[0]!;
    expect(JSON.parse(post.body)).toEqual({ labels: ["Bug"] });
    expect(post.headers.get("authorization")).toBe(`Bearer ${o.githubToken}`);

    const [r] = await runsFor(db, event.id);
    expect(r).toMatchObject({
      status: "succeeded",
      githubStatus: "succeeded",
      githubResult: { labelName: "Bug", alreadyApplied: false },
      slackStatus: "skipped",
      slackError: "No Slack webhook is configured (Settings → Slack).",
    });
    expect((await reloadEvent(db, event.id)).status).toBe("processed");
  });

  it("does not write when the issue already has the label (case-insensitive)", async () => {
    const { event, base } = await setup();
    const gh = mockFetch({ [`GET ${base}/issues/7/labels`]: () => json([{ name: "BUG" }]) });
    await run(event.id);
    expect(posts(gh.calls)).toHaveLength(0);
    const [r] = await runsFor(db, event.id);
    expect(r).toMatchObject({
      githubStatus: "succeeded",
      githubResult: { labelName: "BUG", alreadyApplied: true },
    });
  });

  it("fails clearly and permanently when the label does not exist in the repository", async () => {
    const { event, base, login } = await setup({ actionValue: "bgu" });
    const gh = mockFetch({
      [`GET ${base}/issues/7/labels`]: () => json([]),
      [`GET ${base}/labels`]: () => json([{ name: "bug" }]),
    });
    expect(await run(event.id)).toEqual({ kind: "done" }); // no retry for a permanent problem
    expect(posts(gh.calls)).toHaveLength(0); // never silently creates a new label
    const [r] = await runsFor(db, event.id);
    expect(r).toMatchObject({ status: "failed", githubStatus: "failed" });
    expect(r!.githubError).toBe(
      `Label “bgu” does not exist in ${login}/sandbox. Create it under Issues → Labels, or change the rule.`,
    );
  });

  it("retries a GitHub 502 and applies the label exactly once", async () => {
    const { event, base } = await setup();
    let postCount = 0;
    const gh = mockFetch({
      [`GET ${base}/issues/7/labels`]: () => json(postCount > 1 ? [{ name: "bug" }] : []),
      [`GET ${base}/labels`]: () => json([{ name: "bug" }]),
      [`POST ${base}/issues/7/labels`]: () => {
        postCount++;
        return postCount === 1 ? json({ message: "Bad Gateway" }, 502) : json([{ name: "bug" }]);
      },
    });
    expect((await run(event.id, 1)).kind).toBe("retry");
    let [r] = await runsFor(db, event.id);
    expect(r).toMatchObject({ githubStatus: "pending", githubAttempts: 1 });
    expect(r!.githubError).toMatch(/502/);

    expect(await run(event.id, 2)).toEqual({ kind: "done" });
    [r] = await runsFor(db, event.id);
    expect(r).toMatchObject({ githubStatus: "succeeded", githubAttempts: 2 });
    expect(postCount).toBe(2); // one failed attempt + one successful write
    expect(gh.calls.length).toBeGreaterThan(0);
  });

  it("reports a missing issue as a permanent, readable failure", async () => {
    const { event, base } = await setup();
    mockFetch({ [`GET ${base}/issues/7/labels`]: () => json({ message: "Not Found" }, 404) });
    await run(event.id);
    const [r] = await runsFor(db, event.id);
    expect(r).toMatchObject({ status: "failed", githubStatus: "failed" });
    expect(r!.githubError).toMatch(/Issue #7 was not found/);
  });

  it("flags the user for re-authentication when GitHub answers 401", async () => {
    const { o, event, base } = await setup();
    mockFetch({ [`GET ${base}/issues/7/labels`]: () => json({ message: "Bad credentials" }, 401) });
    expect(await run(event.id)).toEqual({ kind: "done" });
    const [r] = await runsFor(db, event.id);
    expect(r!.githubError).toMatch(/Sign in again/);
    const [u] = await db.select().from(users).where(eq(users.id, o.user.id));
    expect(u!.githubReauthRequiredAt).not.toBeNull();
  });

  it("treats a secondary rate limit (403) as transient", async () => {
    const { event, base } = await setup();
    mockFetch({
      [`GET ${base}/issues/7/labels`]: () =>
        json({ message: "You have exceeded a secondary rate limit. Please wait a few minutes." }, 403),
    });
    expect((await run(event.id)).kind).toBe("retry");
  });
});

describe("add_comment", () => {
  const commentRule = { actionType: "add_comment" as const, actionValue: "Thanks for the report!" };

  it("posts the comment with a footer and a hidden per-run marker", async () => {
    const { event, base } = await setup(commentRule);
    const gh = mockFetch({
      [`GET ${base}/issues/7/comments`]: () => json([]),
      [`POST ${base}/issues/7/comments`]: () =>
        json({ id: 555, html_url: "https://github.com/x/sandbox/issues/7#issuecomment-555" }, 201),
    });
    expect(await run(event.id)).toEqual({ kind: "done" });

    const [r] = await runsFor(db, event.id);
    const body = JSON.parse(posts(gh.calls)[0]!.body).body as string;
    expect(body.startsWith("Thanks for the report!")).toBe(true);
    expect(body).toContain("Posted automatically by Automation Bot · rule “Bug issue automation”");
    expect(body).toContain(commentMarker(r!.id));
    expect(r).toMatchObject({
      status: "succeeded",
      githubResult: {
        commentId: 555,
        commentUrl: "https://github.com/x/sandbox/issues/7#issuecomment-555",
        alreadyApplied: false,
      },
    });
    // Only recent comments are scanned.
    const since = gh.calls.find((c) => c.method === "GET")!.url.searchParams.get("since");
    expect(since).toBeTruthy();
  });

  it("does not post twice: after a crash, the comment carrying this run's marker counts as done", async () => {
    const { event, base, login } = await setup(commentRule);
    const posted: Array<{ id: number; html_url: string; body: string; user: { login: string } }> = [];
    mockFetch({
      [`GET ${base}/issues/7/comments`]: () => json(posted),
      [`POST ${base}/issues/7/comments`]: (req) => {
        const comment = {
          id: 900 + posted.length,
          html_url: `https://github.com/c/${900 + posted.length}`,
          body: JSON.parse(req.body).body as string,
          user: { login },
        };
        posted.push(comment);
        return json(comment, 201);
      },
    });

    expect(await run(event.id, 1)).toEqual({ kind: "done" });
    expect(posted).toHaveLength(1);

    // Simulate a crash between GitHub accepting the comment and us recording the result.
    const [r] = await runsFor(db, event.id);
    await db
      .update(automationRuns)
      .set({ githubStatus: "pending", status: "running", githubResult: null, slackStatus: "pending" })
      .where(eq(automationRuns.id, r!.id));
    await db.update(webhookEvents).set({ status: "processing" }).where(eq(webhookEvents.id, event.id));

    expect(await run(event.id, 2)).toEqual({ kind: "done" });
    expect(posted).toHaveLength(1); // not posted again
    const [after] = await runsFor(db, event.id);
    expect(after).toMatchObject({
      githubStatus: "succeeded",
      githubResult: { commentId: 900, alreadyApplied: true },
    });
  });

  it("ignores a copied marker in someone else's comment", async () => {
    const { event, base } = await setup(commentRule);
    const gh = mockFetch({
      // Another account pasted this run's marker; it must not suppress our comment.
      [`GET ${base}/issues/7/comments`]: async () => {
        const [r] = await runsFor(db, event.id);
        return json([{ id: 1, html_url: "u", body: commentMarker(r!.id), user: { login: "someone-else" } }]);
      },
      [`POST ${base}/issues/7/comments`]: () => json({ id: 2, html_url: "u2" }, 201),
    });
    await run(event.id);
    expect(posts(gh.calls)).toHaveLength(1);
  });
});

describe("commentBody", () => {
  it("strips markdown/HTML control characters from the rule name in the footer", () => {
    const body = commentBody("text", "<b>*evil*</b> [x](y)", "run-1");
    expect(body).toContain("rule “bevil/b x(y)”");
    expect(body.endsWith(commentMarker("run-1"))).toBe(true);
  });
});
