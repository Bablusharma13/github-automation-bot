import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/server/db";
import { jobs } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import {
  claimDueJobs,
  completeJob,
  reapAbandonedJobs,
  rescheduleJob,
  secondsUntilDue,
} from "@/server/jobs/queue";
import { createTestDb } from "../helpers/db";
import { createEvent, createOwnerWithRepo, reloadJob } from "../helpers/fixtures";

let db: Db;
let close: () => Promise<void>;
let owner: Awaited<ReturnType<typeof createOwnerWithRepo>>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  owner = await createOwnerWithRepo(db, getEnv(), "queue-owner");
});
afterAll(async () => close());
// Each test starts with an empty queue so claims are deterministic.
beforeEach(async () => {
  await db.delete(jobs);
});

describe("job queue", () => {
  it("claims a due job: marks it running, counts the attempt, sets a lease", async () => {
    const { job } = await createEvent(db, owner);
    const claimed = await claimDueJobs(db);
    expect(claimed.map((j) => j.id)).toEqual([job!.id]);
    expect(claimed[0]).toMatchObject({ status: "running", attempts: 1 });
    const leaseSeconds = (claimed[0]!.lockedUntil!.getTime() - Date.now()) / 1000;
    expect(leaseSeconds).toBeGreaterThan(100);
  });

  it("does not claim a job twice while its lease is valid", async () => {
    await createEvent(db, owner);
    expect(await claimDueJobs(db)).toHaveLength(1);
    expect(await claimDueJobs(db)).toHaveLength(0);
  });

  it("does not claim jobs scheduled in the future", async () => {
    const { job } = await createEvent(db, owner);
    await db
      .update(jobs)
      .set({ runAt: sql`now() + interval '10 minutes'` })
      .where(eq(jobs.id, job!.id));
    expect(await claimDueJobs(db)).toHaveLength(0);
  });

  it("re-claims a running job whose lease expired (worker crashed)", async () => {
    const { job } = await createEvent(db, owner);
    await claimDueJobs(db);
    await db
      .update(jobs)
      .set({ lockedUntil: sql`now() - interval '1 second'` })
      .where(eq(jobs.id, job!.id));
    const again = await claimDueJobs(db);
    expect(again.map((j) => j.id)).toEqual([job!.id]);
    expect(again[0]!.attempts).toBe(2);
  });

  it("never claims a job that has no attempts left", async () => {
    const { job } = await createEvent(db, owner);
    await db.update(jobs).set({ attempts: 6, maxAttempts: 6 }).where(eq(jobs.id, job!.id));
    expect(await claimDueJobs(db)).toHaveLength(0);
  });

  it("fences stale workers: a worker whose lease was re-claimed cannot complete the job", async () => {
    const { job } = await createEvent(db, owner);
    const [first] = await claimDueJobs(db);
    await db
      .update(jobs)
      .set({ lockedUntil: sql`now() - interval '1 second'` })
      .where(eq(jobs.id, job!.id));
    const [second] = await claimDueJobs(db);

    expect(await completeJob(db, first!)).toBe(false); // stale owner: no effect
    expect((await reloadJob(db, job!.id)).status).toBe("running");
    expect(await completeJob(db, second!)).toBe(true); // current owner
    expect((await reloadJob(db, job!.id)).status).toBe("succeeded");
  });

  it("reschedules with a delay and reports when it is next due", async () => {
    const { job } = await createEvent(db, owner);
    const [claimed] = await claimDueJobs(db);
    expect(await rescheduleJob(db, claimed!, 60, "GitHub 502")).toBe(true);
    const row = await reloadJob(db, job!.id);
    expect(row).toMatchObject({ status: "pending", lastError: "GitHub 502", lockedUntil: null });
    const wait = await secondsUntilDue(db, [job!.id]);
    expect(wait).toBeGreaterThan(55);
    expect(wait).toBeLessThanOrEqual(60);
  });

  it("reaps jobs whose worker died during the final attempt", async () => {
    const { job } = await createEvent(db, owner);
    await db
      .update(jobs)
      .set({ status: "running", attempts: 6, maxAttempts: 6, lockedUntil: sql`now() - interval '1 second'` })
      .where(eq(jobs.id, job!.id));
    const reaped = await reapAbandonedJobs(db);
    expect(reaped.map((j) => j.id)).toEqual([job!.id]);
    const row = await reloadJob(db, job!.id);
    expect(row.status).toBe("failed");
    expect(row.lastError).toMatch(/lease expired/);
  });
});
