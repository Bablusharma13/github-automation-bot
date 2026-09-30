import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db";
import { sessions } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import { handleCronWorker } from "@/server/jobs/cron";
import { createSignedInUser } from "../helpers/auth";
import { createTestDb } from "../helpers/db";
import { createEvent, createOwnerWithRepo, reloadJob } from "../helpers/fixtures";

let db: Db;
let close: () => Promise<void>;
let env: Env;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv();
});
afterAll(async () => close());

const cronRequest = (authorization?: string) =>
  new NextRequest(`${env.APP_URL}/api/cron/worker`, {
    headers: authorization ? { authorization } : {},
  });

describe("GET /api/cron/worker", () => {
  it("rejects requests without the bearer secret", async () => {
    const res = await handleCronWorker(cronRequest(), { db, env });
    expect(res.status).toBe(401);
  });

  it("rejects a wrong or malformed secret", async () => {
    // (Surrounding whitespace is not a variant: the Fetch Headers API strips it per spec.)
    for (const auth of [
      "Bearer wrong-secret",
      env.CRON_SECRET,
      `Basic ${env.CRON_SECRET}`,
      `Bearer ${env.CRON_SECRET}x`,
      `Bearer ${env.CRON_SECRET.slice(0, -1)}`,
    ]) {
      expect((await handleCronWorker(cronRequest(auth), { db, env })).status).toBe(401);
    }
  });

  it("drains due jobs and purges expired sessions with the right secret, returning only counts", async () => {
    const owner = await createOwnerWithRepo(db, env, "cron-owner");
    const { job } = await createEvent(db, owner);
    const stale = await createSignedInUser(db, env, "cron-stale");
    await db
      .update(sessions)
      .set({ expiresAt: sql`now() - interval '2 days'` })
      .where(sql`${sessions.userId} = ${stale.user.id}`);

    const res = await handleCronWorker(
      cronRequest(`Bearer ${env.CRON_SECRET}`),
      { db, env },
      {
        processor: async () => ({ kind: "done" }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, claimed: 1, succeeded: 1, failed: 0, sessionsDeleted: 1 });
    expect(Object.values(body).every((v) => typeof v === "number" || typeof v === "boolean")).toBe(true);
    expect((await reloadJob(db, job!.id)).status).toBe("succeeded");
  });
});
