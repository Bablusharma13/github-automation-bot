import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@/server/db";
import { automationRuns, webhookEvents } from "@/server/db/schema";
import { getEnv } from "@/server/env";
import { listRecentEvents } from "@/server/events/service";
import { createSignedInUser } from "../helpers/auth";
import { createTestDb } from "../helpers/db";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("listRecentEvents", () => {
  it("returns only the caller's events, newest first, without the stored body", async () => {
    const env = getEnv();
    const a = await createSignedInUser(db, env, "events-a");
    const b = await createSignedInUser(db, env, "events-b");
    const subject = (title: string) => ({
      kind: "issue" as const,
      number: 1,
      title,
      body: "private body text",
      url: "https://github.com/x/y/issues/1",
      state: "open",
      author: "x",
      labels: [],
    });
    await db.insert(webhookEvents).values([
      {
        deliveryId: "ev-a-1",
        eventType: "issues",
        userId: a.user.id,
        subject: subject("A older"),
        receivedAt: new Date(Date.now() - 60_000),
      },
      { deliveryId: "ev-a-2", eventType: "issues", userId: a.user.id, subject: subject("A newer") },
      { deliveryId: "ev-b-1", eventType: "issues", userId: b.user.id, subject: subject("B secret") },
      { deliveryId: "ev-none", eventType: "issues", userId: null },
    ]);

    const events = await listRecentEvents(db, a.user.id);
    expect(events.map((e) => e.subject?.title)).toEqual(["A newer", "A older"]);
    expect(JSON.stringify(events)).not.toContain("private body text");
    expect(JSON.stringify(events)).not.toContain("B secret");
  });
});

describe("listRecentEvents run counts", () => {
  it("reports how many rules matched each event", async () => {
    const env = getEnv();
    const c = await createSignedInUser(db, env, "events-count");
    const [ev] = await db
      .insert(webhookEvents)
      .values({ deliveryId: "ev-count-1", eventType: "issues", userId: c.user.id, status: "processed" })
      .returning();
    const [ev2] = await db
      .insert(webhookEvents)
      .values({ deliveryId: "ev-count-2", eventType: "issues", userId: c.user.id, status: "processed" })
      .returning();
    await db.insert(automationRuns).values({
      webhookEventId: ev2!.id,
      userId: c.user.id,
      ruleName: "r",
      actionType: "add_label",
      actionValue: "bug",
    });
    const events = await listRecentEvents(db, c.user.id);
    const byId = Object.fromEntries(events.map((e) => [e.id, e.runCount]));
    expect(byId[ev!.id]).toBe(0);
    expect(byId[ev2!.id]).toBe(1);
  });
});
