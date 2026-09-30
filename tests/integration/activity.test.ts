import { eq, ne, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "@/server/auth/handlers";
import type { Executors } from "@/server/automation/executors";
import { StepError } from "@/server/automation/errors";
import { processEvent } from "@/server/automation/process-event";
import type { Db } from "@/server/db";
import { automationRuns, jobs, webhookEvents } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import {
  getEventHandler,
  listEventsHandler,
  retryEventHandler,
  statsHandler,
} from "@/server/events/handlers";
import { drainJobs } from "@/server/jobs/worker";
import { apiRequest } from "../helpers/auth";
import { createTestDb } from "../helpers/db";
import {
  createEvent,
  createOwnerWithRepo,
  createRule,
  issueSubject,
  reloadEvent,
  reloadJob,
  runsFor,
} from "../helpers/fixtures";

let db: Db;
let close: () => Promise<void>;
let env: Env;
let deps: AuthDeps;
let seq = 0;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv();
  deps = { db, env };
});
afterAll(async () => close());

const newOwner = () => createOwnerWithRepo(db, env, `activity-owner-${++seq}`);
const list = async (cookie: string, query = "") =>
  listEventsHandler(apiRequest(env, "GET", `/api/events${query}`, { cookie }), deps);
const detail = (cookie: string, id: string) =>
  getEventHandler(apiRequest(env, "GET", `/api/events/${id}`, { cookie }), deps, id);
const retry = (cookie: string, id: string, schedule = vi.fn(), origin?: string) =>
  retryEventHandler(
    apiRequest(env, "POST", `/api/events/${id}/retry`, { cookie, origin }),
    deps,
    id,
    schedule,
  );

const ok: Executors = {
  github: async (ctx) => ({ labelName: ctx.run.actionValue, alreadyApplied: false }),
  slack: async () => ({ status: "sent" }),
};
const process = (eventId: string, executors: Executors, attempt = 1, isFinalAttempt = false) =>
  processEvent(db, env, { webhookEventId: eventId, attempt, isFinalAttempt }, executors);

describe("GET /api/events", () => {
  it("returns the caller's events newest first, with runs and job state", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event: older } = await createEvent(db, o, { subject: issueSubject({ title: "bug: older" }) });
    await db
      .update(webhookEvents)
      .set({ receivedAt: sql`now() - interval '1 minute'` })
      .where(eq(webhookEvents.id, older.id));
    const { event: newer } = await createEvent(db, o, { subject: issueSubject({ title: "bug: newer" }) });
    await process(newer.id, ok);

    const res = await list(o.cookie);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events.map((e: { subject: { title: string } }) => e.subject.title)).toEqual([
      "bug: newer",
      "bug: older",
    ]);
    const [first] = body.events;
    expect(first.runs).toHaveLength(1);
    expect(first.runs[0]).toMatchObject({
      ruleName: "Bug issue automation",
      githubStatus: "succeeded",
      slackStatus: "succeeded",
    });
    expect(first.job).toMatchObject({ status: "pending", attempts: 0, maxAttempts: 6 });
    // No stored issue body, no secrets in the list payload.
    expect(JSON.stringify(body)).not.toContain("The session is lost");
  });

  it("never returns another user's events", async () => {
    const a = await newOwner();
    const b = await newOwner();
    await createEvent(db, b);
    expect((await (await list(a.cookie)).json()).events).toEqual([]);
  });

  it("paginates with a cursor and filters failed events", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const created = [];
    for (let i = 0; i < 3; i++) {
      const { event } = await createEvent(db, o, { subject: issueSubject({ title: `bug ${i}` }) });
      await db
        .update(webhookEvents)
        .set({ receivedAt: sql`now() - (${i}::int * interval '1 minute')` })
        .where(eq(webhookEvents.id, event.id));
      created.push(event);
    }
    const page1 = await (await list(o.cookie, "?limit=2")).json();
    expect(page1.events).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();
    const page2 = await (
      await list(o.cookie, `?limit=2&before=${encodeURIComponent(page1.nextCursor)}`)
    ).json();
    expect(page2.events.map((e: { subject: { title: string } }) => e.subject.title)).toEqual(["bug 2"]);
    expect(page2.nextCursor).toBeNull();

    const failing: Executors = {
      ...ok,
      github: async () => {
        throw new StepError("Label missing", false);
      },
    };
    await process(created[1]!.id, failing);
    const failed = await (await list(o.cookie, "?filter=failed")).json();
    expect(failed.events.map((e: { id: string }) => e.id)).toEqual([created[1]!.id]);

    expect((await list(o.cookie, "?limit=0")).status).toBe(400);
    expect((await list(o.cookie, "?filter=everything")).status).toBe(400);
  });

  it("requires authentication", async () => {
    expect((await listEventsHandler(apiRequest(env, "GET", "/api/events"), deps)).status).toBe(401);
  });
});

describe("GET /api/events/:id", () => {
  it("returns details (with a body preview) only to the owner", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const { event } = await createEvent(db, a);
    const own = await detail(a.cookie, event.id);
    expect(own.status).toBe(200);
    const body = await own.json();
    expect(body.event).toMatchObject({
      id: event.id,
      deliveryId: event.deliveryId,
      bodyPreview: "The session is lost when the page reloads.",
    });

    const foreign = await detail(b.cookie, event.id);
    expect(foreign.status).toBe(404);
    expect((await detail(a.cookie, "not-a-uuid")).status).toBe(404);
  });
});

describe("GET /api/stats", () => {
  it("counts only the caller's data", async () => {
    const o = await newOwner();
    await createRule(db, o);
    await createRule(db, o, { enabled: false, name: "off" });
    const { event: good } = await createEvent(db, o);
    const { event: bad } = await createEvent(db, o);
    await process(good.id, ok);
    await process(bad.id, {
      ...ok,
      github: async () => {
        throw new StepError("nope", false);
      },
    });
    const other = await newOwner();
    await createEvent(db, other);

    const stats = await (
      await statsHandler(apiRequest(env, "GET", "/api/stats", { cookie: o.cookie }), deps)
    ).json();
    expect(stats).toEqual({
      connectedRepositories: 1,
      enabledRules: 1,
      events24h: 2,
      eventsTotal: 2,
      actionsSucceeded: 1,
      actionsFailed: 1,
      retriesPending: 0,
    });
  });
});

describe("POST /api/events/:id/retry", () => {
  it("re-runs only the failed GitHub step, reports the new outcome to Slack, and drains", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event, job } = await createEvent(db, o);
    const githubCalls: string[] = [];
    const slackCalls: string[] = [];
    let labelExists = false;
    const executors: Executors = {
      github: async () => {
        githubCalls.push("github");
        if (!labelExists) throw new StepError("Label “bug” does not exist", false);
        return { labelName: "bug", alreadyApplied: false };
      },
      slack: async (ctx) => {
        slackCalls.push(ctx.run.githubStatus);
        return { status: "sent" };
      },
    };
    // Earlier tests in this file leave pending jobs behind; this test drains the real
    // queue, so keep only its own job there.
    await db.delete(jobs).where(ne(jobs.webhookEventId, event.id));
    // Fail permanently through the real worker, as production would.
    await drainJobs(db, env, { budgetMs: 10_000, processor: (i) => processEvent(db, env, i, executors) });
    let [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ status: "failed", githubStatus: "failed", slackStatus: "succeeded" });
    expect(slackCalls).toEqual(["failed"]);

    // The user fixes the problem (creates the label) and retries.
    labelExists = true;
    const schedule = vi.fn();
    const res = await retry(o.cookie, event.id, schedule);
    expect(res.status).toBe(202);
    expect(schedule).toHaveBeenCalledTimes(1);
    [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ status: "running", githubStatus: "pending", slackStatus: "pending" });
    expect(await reloadJob(db, job!.id)).toMatchObject({ status: "pending", attempts: 0, lastError: null });
    expect((await reloadEvent(db, event.id)).status).toBe("processing");

    await drainJobs(db, env, { budgetMs: 10_000, processor: (i) => processEvent(db, env, i, executors) });
    [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ status: "succeeded", githubStatus: "succeeded", slackStatus: "succeeded" });
    expect(githubCalls).toHaveLength(2);
    expect(slackCalls).toEqual(["failed", "succeeded"]); // Slack reported the new outcome
  });

  it("does not repeat a GitHub step that already succeeded when only Slack failed", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event } = await createEvent(db, o);
    let github = 0;
    const slackDown: Executors = {
      github: async () => {
        github++;
        return { labelName: "bug", alreadyApplied: false };
      },
      slack: async () => {
        throw new StepError("Slack rejected the notification (404: no_service).", false);
      },
    };
    await process(event.id, slackDown);
    expect((await runsFor(db, event.id))[0]).toMatchObject({
      githubStatus: "succeeded",
      slackStatus: "failed",
    });

    await retry(o.cookie, event.id);
    expect((await runsFor(db, event.id))[0]).toMatchObject({
      githubStatus: "succeeded",
      slackStatus: "pending",
    });
    await process(event.id, { ...slackDown, slack: async () => ({ status: "sent" }) });
    expect(github).toBe(1);
    expect((await runsFor(db, event.id))[0]).toMatchObject({ status: "succeeded", slackStatus: "succeeded" });
  });

  it("refuses when there is nothing to retry or the event is being processed", async () => {
    const o = await newOwner();
    await createRule(db, o);
    const { event, job } = await createEvent(db, o);
    await process(event.id, ok);
    const nothing = await retry(o.cookie, event.id);
    expect(nothing.status).toBe(409);
    expect((await nothing.json()).error.code).toBe("nothing_to_retry");

    const { event: busy, job: busyJob } = await createEvent(db, o);
    await db.update(webhookEvents).set({ status: "failed" }).where(eq(webhookEvents.id, busy.id));
    await db
      .update(jobs)
      .set({ status: "running", lockedUntil: sql`now() + interval '1 minute'` })
      .where(eq(jobs.id, busyJob!.id));
    const running = await retry(o.cookie, busy.id);
    expect(running.status).toBe(409);
    expect((await running.json()).error.code).toBe("in_progress");
    void job;
  });

  it("is owner-only and same-origin only", async () => {
    const a = await newOwner();
    const b = await newOwner();
    await createRule(db, a);
    const { event } = await createEvent(db, a);
    await process(event.id, {
      ...ok,
      github: async () => {
        throw new StepError("x", false);
      },
    });
    const schedule = vi.fn();
    expect((await retry(b.cookie, event.id, schedule)).status).toBe(404);
    expect((await retry(a.cookie, event.id, schedule, "https://evil.example")).status).toBe(403);
    expect(schedule).not.toHaveBeenCalled();
    const [run] = await db.select().from(automationRuns).where(eq(automationRuns.webhookEventId, event.id));
    expect(run!.status).toBe("failed"); // untouched
  });
});
