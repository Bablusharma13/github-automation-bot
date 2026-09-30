import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProcessInput, ProcessOutcome } from "@/server/automation/process-event";
import type { Db } from "@/server/db";
import { jobs } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import { drainJobs } from "@/server/jobs/worker";
import { createTestDb } from "../helpers/db";
import { createEvent, createOwnerWithRepo, reloadEvent, reloadJob } from "../helpers/fixtures";

let db: Db;
let close: () => Promise<void>;
let env: Env;
let owner: Awaited<ReturnType<typeof createOwnerWithRepo>>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv();
  owner = await createOwnerWithRepo(db, env, "worker-owner");
});
afterAll(async () => close());
beforeEach(async () => {
  await db.delete(jobs);
});

/** A processor that returns the scripted outcomes in order and records its inputs. */
function scripted(...outcomes: Array<ProcessOutcome | Error>) {
  const calls: ProcessInput[] = [];
  const processor = async (input: ProcessInput): Promise<ProcessOutcome> => {
    calls.push(input);
    const next = outcomes.shift() ?? { kind: "done" as const };
    if (next instanceof Error) throw next;
    return next;
  };
  return { processor, calls };
}

describe("drainJobs", () => {
  it("processes a due job and marks it succeeded", async () => {
    const { job } = await createEvent(db, owner);
    const { processor, calls } = scripted({ kind: "done" });
    const stats = await drainJobs(db, env, { budgetMs: 10_000, processor });
    expect(stats).toMatchObject({ claimed: 1, succeeded: 1, retried: 0, failed: 0 });
    expect(calls[0]).toMatchObject({ attempt: 1, isFinalAttempt: false });
    expect((await reloadJob(db, job!.id)).status).toBe("succeeded");
  });

  it("reschedules a transient failure with backoff instead of losing it", async () => {
    const { job } = await createEvent(db, owner);
    const { processor } = scripted({ kind: "retry", error: "GitHub returned 502" });
    const stats = await drainJobs(db, env, { budgetMs: 10_000, processor, backoff: () => 120 });
    expect(stats.retried).toBe(1);
    const row = await reloadJob(db, job!.id);
    expect(row).toMatchObject({ status: "pending", attempts: 1, lastError: "GitHub returned 502" });
    expect(row.runAt.getTime() - Date.now()).toBeGreaterThan(110_000);
  });

  it("retries an unexpected crash of the processor like a transient failure", async () => {
    const { job } = await createEvent(db, owner);
    const { processor } = scripted(new Error("connection terminated unexpectedly"));
    await drainJobs(db, env, { budgetMs: 10_000, processor, backoff: () => 120 });
    expect(await reloadJob(db, job!.id)).toMatchObject({
      status: "pending",
      lastError: "connection terminated unexpectedly",
    });
  });

  it("gives up after the final attempt and marks the event failed with the reason", async () => {
    const { event, job } = await createEvent(db, owner);
    await db.update(jobs).set({ attempts: 5, maxAttempts: 6 }).where(eq(jobs.id, job!.id));
    const { processor, calls } = scripted(new Error("still down"));
    const stats = await drainJobs(db, env, { budgetMs: 10_000, processor });
    expect(calls[0]).toMatchObject({ attempt: 6, isFinalAttempt: true });
    expect(stats.failed).toBe(1);
    expect(await reloadJob(db, job!.id)).toMatchObject({ status: "failed", lastError: "still down" });
    const ev = await reloadEvent(db, event.id);
    expect(ev.status).toBe("failed");
    expect(ev.errorMessage).toMatch(/Gave up after 6 attempts: still down/);
  });

  it("waits for its own short retry within the budget (waitForRetries)", async () => {
    const { job } = await createEvent(db, owner);
    const { processor, calls } = scripted({ kind: "retry", error: "Slack 503" }, { kind: "done" });
    const stats = await drainJobs(db, env, {
      budgetMs: 10_000,
      processor,
      waitForRetries: true,
      backoff: () => 1,
    });
    expect(calls.map((c) => c.attempt)).toEqual([1, 2]);
    expect(stats).toMatchObject({ retried: 1, succeeded: 1 });
    expect(await reloadJob(db, job!.id)).toMatchObject({ status: "succeeded", attempts: 2 });
  });

  it("recovers a job whose previous worker died mid-processing", async () => {
    const { job } = await createEvent(db, owner);
    await db
      .update(jobs)
      .set({ status: "running", attempts: 1, lockedUntil: sql`now() - interval '1 second'` })
      .where(eq(jobs.id, job!.id));
    const { processor, calls } = scripted({ kind: "done" });
    await drainJobs(db, env, { budgetMs: 10_000, processor });
    expect(calls[0]!.attempt).toBe(2);
    expect((await reloadJob(db, job!.id)).status).toBe("succeeded");
  });

  it("marks final-attempt jobs abandoned by a dead worker as failed", async () => {
    const { event, job } = await createEvent(db, owner);
    await db
      .update(jobs)
      .set({ status: "running", attempts: 6, maxAttempts: 6, lockedUntil: sql`now() - interval '1 second'` })
      .where(eq(jobs.id, job!.id));
    const stats = await drainJobs(db, env, { budgetMs: 10_000, processor: scripted().processor });
    expect(stats.reaped).toBe(1);
    expect((await reloadEvent(db, event.id)).status).toBe("failed");
  });

  it("stops claiming new work when the time budget is used up", async () => {
    await createEvent(db, owner);
    const { processor, calls } = scripted({ kind: "done" });
    const stats = await drainJobs(db, env, { budgetMs: 1_000, processor }); // below the safety margin
    expect(stats.claimed).toBe(0);
    expect(calls).toHaveLength(0);
  });
});
