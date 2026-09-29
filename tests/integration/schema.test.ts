import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb } from "../helpers/db";
import { repositories, users, webhookEvents } from "@/server/db/schema";
import type { Db } from "@/server/db";

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
});
afterAll(async () => close());

describe("database constraints (real migrations on PGlite)", () => {
  it("enforces UNIQUE(delivery_id) on webhook_events", async () => {
    await db.insert(webhookEvents).values({ deliveryId: "dup-1", eventType: "issues" });
    await expect(
      db.insert(webhookEvents).values({ deliveryId: "dup-1", eventType: "issues" }),
    ).rejects.toThrow();
  });

  it("allows only one active connection per GitHub repository", async () => {
    const [a, b] = await db
      .insert(users)
      .values([
        { githubUserId: 1, githubLogin: "alice", accessTokenEnc: "x" },
        { githubUserId: 2, githubLogin: "bob", accessTokenEnc: "x" },
      ])
      .returning();
    const repo = {
      githubRepoId: 42,
      owner: "o",
      name: "r",
      fullName: "o/r",
      htmlUrl: "https://github.com/o/r",
    };
    await db.insert(repositories).values({ ...repo, userId: a!.id, active: true });
    await expect(db.insert(repositories).values({ ...repo, userId: b!.id, active: true })).rejects.toThrow();
    // An inactive row for another user is fine (history is preserved after disconnect).
    await db.insert(repositories).values({ ...repo, userId: b!.id, active: false });
  });
});
