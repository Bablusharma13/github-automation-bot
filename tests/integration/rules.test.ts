import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AuthDeps } from "@/server/auth/handlers";
import type { Executors } from "@/server/automation/executors";
import { processEvent } from "@/server/automation/process-event";
import type { Db } from "@/server/db";
import { repositories, rules } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import {
  createRuleHandler,
  deleteRuleHandler,
  getRuleHandler,
  listRulesHandler,
  updateRuleHandler,
} from "@/server/rules/handlers";
import { apiRequest } from "../helpers/auth";
import { createTestDb } from "../helpers/db";
import { createEvent, createOwnerWithRepo, noTriage, runsFor } from "../helpers/fixtures";

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

const newOwner = () => createOwnerWithRepo(db, env, `rules-owner-${++seq}`);

const validRule = (repositoryId: string, overrides: Record<string, unknown> = {}) => ({
  repositoryId,
  name: "Bug issue automation",
  eventType: "issues",
  eventActions: ["opened"],
  keywords: ["Bug", "  bug ", "Crash"],
  actionType: "add_label",
  actionValue: "bug",
  notifySlack: true,
  ...overrides,
});

async function create(cookie: string, body: unknown) {
  return createRuleHandler(apiRequest(env, "POST", "/api/rules", { cookie, body }), deps);
}
async function createOk(cookie: string, body: unknown) {
  const res = await create(cookie, body);
  expect(res.status).toBe(201);
  return (await res.json()).rule as { id: string } & Record<string, unknown>;
}
const patch = (cookie: string, id: string, body: unknown, origin?: string) =>
  updateRuleHandler(apiRequest(env, "PATCH", `/api/rules/${id}`, { cookie, body, origin }), deps, id);
const del = (cookie: string, id: string) =>
  deleteRuleHandler(apiRequest(env, "DELETE", `/api/rules/${id}`, { cookie }), deps, id);
const get = (cookie: string, id: string) =>
  getRuleHandler(apiRequest(env, "GET", `/api/rules/${id}`, { cookie }), deps, id);

describe("POST /api/rules", () => {
  it("creates a rule on a connected repository with normalized keywords and defaults", async () => {
    const o = await newOwner();
    const rule = await createOk(o.cookie, validRule(o.repo.id, { eventActions: ["opened", "opened"] }));
    expect(rule).toMatchObject({
      repositoryId: o.repo.id,
      repositoryFullName: o.repo.fullName,
      enabled: true,
      eventActions: ["opened"],
      keywords: ["bug", "crash"],
      keywordScope: "title",
      actionType: "add_label",
      actionValue: "bug",
      notifySlack: true,
    });
  });

  it("refuses to create a rule on another user's repository", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const res = await create(a.cookie, validRule(b.repo.id));
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("repository_not_found");
    expect(await db.select().from(rules).where(eq(rules.repositoryId, b.repo.id))).toHaveLength(0);
  });

  it("refuses to create a rule on a disconnected repository", async () => {
    const o = await newOwner();
    await db.update(repositories).set({ active: false }).where(eq(repositories.id, o.repo.id));
    expect((await create(o.cookie, validRule(o.repo.id))).status).toBe(404);
  });

  it("validates the rule", async () => {
    const o = await newOwner();
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "  " }, /Name is required/],
      [{ eventType: "push" }, /eventType/],
      [{ eventActions: [] }, /at least one event action/],
      [{ eventActions: ["deleted"] }, /eventActions/],
      [{ keywords: Array.from({ length: 11 }, (_, i) => `k${i}`) }, /At most 10 keywords/],
      [{ keywords: ["x".repeat(51)] }, /at most 50 characters/],
      [{ actionType: "delete_repo" }, /actionType/],
      [{ actionValue: "   " }, /required/],
      [{ actionValue: "l".repeat(51) }, /Label names are at most 50/],
      [{ actionType: "add_comment", actionValue: "c".repeat(2001) }, /Comments are at most 2000/],
      [{ unexpected: true }, /unexpected|Unrecognized/i],
      [{ repositoryId: "not-a-uuid" }, /connected repository/],
    ];
    for (const [override, message] of cases) {
      const res = await create(o.cookie, validRule(o.repo.id, override));
      expect(res.status, JSON.stringify(override)).toBe(400);
      expect((await res.json()).error.message).toMatch(message);
    }
    expect(await db.select().from(rules).where(eq(rules.userId, o.user.id))).toHaveLength(0);
  });

  it("never picks a repository for the caller, even when only one is connected", async () => {
    // Regression guard for the wrong-repository incident (7516002): the repository must be
    // chosen explicitly; the server has no default.
    const o = await newOwner(); // exactly one connected repository
    const withoutRepository: Record<string, unknown> = validRule(o.repo.id);
    delete withoutRepository.repositoryId;
    const res = await create(o.cookie, withoutRepository);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("invalid_input");
    expect(await db.select().from(rules).where(eq(rules.userId, o.user.id))).toHaveLength(0);
  });

  it("accepts a comment rule with a longer body and no keywords", async () => {
    const o = await newOwner();
    const rule = await createOk(
      o.cookie,
      validRule(o.repo.id, { actionType: "add_comment", actionValue: "Thanks! ".repeat(100), keywords: [] }),
    );
    expect(rule.keywords).toEqual([]);
  });

  it("requires authentication and a same-origin request", async () => {
    const o = await newOwner();
    const anon = await createRuleHandler(
      apiRequest(env, "POST", "/api/rules", { body: validRule(o.repo.id) }),
      deps,
    );
    expect(anon.status).toBe(401);
    const crossSite = await createRuleHandler(
      apiRequest(env, "POST", "/api/rules", {
        cookie: o.cookie,
        body: validRule(o.repo.id),
        origin: "https://evil.example",
      }),
      deps,
    );
    expect(crossSite.status).toBe(403);
  });
});

describe("authorization: users only see and change their own rules", () => {
  it("lists only the caller's rules, optionally filtered by repository", async () => {
    const a = await newOwner();
    const b = await newOwner();
    await createOk(a.cookie, validRule(a.repo.id, { name: "A rule" }));
    await createOk(b.cookie, validRule(b.repo.id, { name: "B rule" }));

    const listA = await (
      await listRulesHandler(apiRequest(env, "GET", "/api/rules", { cookie: a.cookie }), deps)
    ).json();
    expect(listA.rules.map((r: { name: string }) => r.name)).toEqual(["A rule"]);

    const filtered = await listRulesHandler(
      apiRequest(env, "GET", `/api/rules?repositoryId=${b.repo.id}`, { cookie: a.cookie }),
      deps,
    );
    expect((await filtered.json()).rules).toEqual([]); // B's repo id reveals nothing
    const bad = await listRulesHandler(
      apiRequest(env, "GET", "/api/rules?repositoryId=x", { cookie: a.cookie }),
      deps,
    );
    expect(bad.status).toBe(400);
  });

  it("returns 404 for another user's rule on read, update and delete — and changes nothing", async () => {
    const a = await newOwner();
    const b = await newOwner();
    const bRule = await createOk(b.cookie, validRule(b.repo.id));

    expect((await get(a.cookie, bRule.id)).status).toBe(404);
    expect((await patch(a.cookie, bRule.id, { enabled: false })).status).toBe(404);
    expect((await del(a.cookie, bRule.id)).status).toBe(404);

    const own = await get(b.cookie, bRule.id);
    expect(own.status).toBe(200);
    expect((await own.json()).rule.enabled).toBe(true);
  });

  it("treats malformed ids as not found", async () => {
    const a = await newOwner();
    expect((await get(a.cookie, "1; drop table rules")).status).toBe(404);
  });
});

describe("PATCH /api/rules/:id", () => {
  it("toggles a rule and updates fields", async () => {
    const o = await newOwner();
    const rule = await createOk(o.cookie, validRule(o.repo.id));
    const res = await patch(o.cookie, rule.id, {
      enabled: false,
      keywords: ["Security"],
      keywordScope: "title_and_body",
    });
    expect(res.status).toBe(200);
    expect((await res.json()).rule).toMatchObject({
      enabled: false,
      keywords: ["security"],
      keywordScope: "title_and_body",
    });
  });

  it("validates the merged rule, not just the changed fields", async () => {
    const o = await newOwner();
    const rule = await createOk(
      o.cookie,
      validRule(o.repo.id, { actionType: "add_comment", actionValue: "c".repeat(200) }),
    );
    // Switching to add_label while keeping a 200-character value must be rejected.
    const res = await patch(o.cookie, rule.id, { actionType: "add_label" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/Label names are at most 50/);
    expect((await patch(o.cookie, rule.id, { eventActions: [] })).status).toBe(400);
    expect((await patch(o.cookie, rule.id, {})).status).toBe(400);
    expect((await patch(o.cookie, rule.id, { repositoryId: o.repo.id })).status).toBe(400);
  });

  it("rejects cross-origin updates", async () => {
    const o = await newOwner();
    const rule = await createOk(o.cookie, validRule(o.repo.id));
    expect((await patch(o.cookie, rule.id, { enabled: false }, "https://evil.example")).status).toBe(403);
    expect((await (await get(o.cookie, rule.id)).json()).rule.enabled).toBe(true);
  });
});

describe("DELETE /api/rules/:id", () => {
  it("deletes the rule but keeps the history of runs it produced", async () => {
    const o = await newOwner();
    const rule = await createOk(o.cookie, validRule(o.repo.id));
    const { event } = await createEvent(db, o);
    const noop: Executors = {
      github: async () => ({ labelName: "bug", alreadyApplied: false }),
      slack: async () => ({ status: "sent" }),
      triage: noTriage,
    };
    await processEvent(db, env, { webhookEventId: event.id, attempt: 1, isFinalAttempt: false }, noop);

    const res = await del(o.cookie, rule.id);
    expect(res.status).toBe(200);
    expect((await get(o.cookie, rule.id)).status).toBe(404);
    const [run] = await runsFor(db, event.id);
    expect(run).toMatchObject({ ruleId: null, ruleName: "Bug issue automation", status: "succeeded" });
  });
});

describe("rules created through the API drive the engine", () => {
  it("matches an event and a disabled rule stops matching", async () => {
    const o = await newOwner();
    const rule = await createOk(o.cookie, validRule(o.repo.id, { keywords: ["login"] }));
    const executors: Executors = {
      github: async () => ({ labelName: "bug", alreadyApplied: false }),
      slack: async () => ({ status: "sent" }),
      triage: noTriage,
    };
    const { event } = await createEvent(db, o);
    await processEvent(db, env, { webhookEventId: event.id, attempt: 1, isFinalAttempt: false }, executors);
    expect(await runsFor(db, event.id)).toHaveLength(1);

    await patch(o.cookie, rule.id, { enabled: false });
    const { event: second } = await createEvent(db, o);
    await processEvent(db, env, { webhookEventId: second.id, attempt: 1, isFinalAttempt: false }, executors);
    expect(await runsFor(db, second.id)).toHaveLength(0);
  });
});
