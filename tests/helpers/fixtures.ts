import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Db } from "@/server/db";
import {
  automationRuns,
  jobs,
  repositories,
  rules,
  webhookEvents,
  type EventSubject,
} from "@/server/db/schema";
import type { Env } from "@/server/env";
import { createSignedInUser } from "./auth";

let repoSeq = 50_000_000;

/** A user with one connected repository. */
export async function createOwnerWithRepo(db: Db, env: Env, login: string) {
  const owner = await createSignedInUser(db, env, login);
  const [repo] = await db
    .insert(repositories)
    .values({
      userId: owner.user.id,
      githubRepoId: ++repoSeq,
      owner: login,
      name: "sandbox",
      fullName: `${login}/sandbox`,
      htmlUrl: `https://github.com/${login}/sandbox`,
      webhookId: repoSeq,
      active: true,
    })
    .returning();
  return { ...owner, repo: repo! };
}

export function issueSubject(overrides: Partial<EventSubject> = {}): EventSubject {
  return {
    kind: "issue",
    number: 7,
    title: "Bug: login fails after refresh",
    body: "The session is lost when the page reloads.",
    url: "https://github.com/o/sandbox/issues/7",
    state: "open",
    author: "reporter",
    labels: [],
    ...overrides,
  };
}

/** An event as ingestion would store it, optionally with its queued job. */
export async function createEvent(
  db: Db,
  owner: { user: { id: string }; repo: { id: string; githubRepoId: number; fullName: string } },
  opts: { action?: string; subject?: EventSubject; withJob?: boolean; eventType?: string } = {},
) {
  const [event] = await db
    .insert(webhookEvents)
    .values({
      deliveryId: randomUUID(),
      eventType: opts.eventType ?? "issues",
      action: opts.action ?? "opened",
      userId: owner.user.id,
      repositoryId: owner.repo.id,
      githubRepoId: owner.repo.githubRepoId,
      repoFullName: owner.repo.fullName,
      senderLogin: "reporter",
      subject: opts.subject ?? issueSubject(),
      status: "received",
    })
    .returning();
  let job: typeof jobs.$inferSelect | undefined;
  if (opts.withJob !== false) {
    [job] = await db.insert(jobs).values({ webhookEventId: event!.id }).returning();
  }
  return { event: event!, job };
}

export async function createRule(
  db: Db,
  owner: { user: { id: string }; repo: { id: string } },
  overrides: Partial<typeof rules.$inferInsert> = {},
) {
  const [rule] = await db
    .insert(rules)
    .values({
      userId: owner.user.id,
      repositoryId: owner.repo.id,
      name: "Bug issue automation",
      eventType: "issues",
      eventActions: ["opened"],
      keywords: ["bug"],
      actionType: "add_label",
      actionValue: "bug",
      notifySlack: true,
      ...overrides,
    })
    .returning();
  return rule!;
}

export async function reloadEvent(db: Db, id: string) {
  const [row] = await db.select().from(webhookEvents).where(eq(webhookEvents.id, id));
  return row!;
}
export async function reloadJob(db: Db, id: string) {
  const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
  return row!;
}
export async function runsFor(db: Db, eventId: string) {
  return db.select().from(automationRuns).where(eq(automationRuns.webhookEventId, eventId));
}
