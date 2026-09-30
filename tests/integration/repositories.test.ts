import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "@/server/auth/handlers";
import type { Db } from "@/server/db";
import { repositories, users } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import {
  connectRepositoryHandler,
  disconnectRepositoryHandler,
  getRepositoryHandler,
  listConnectableHandler,
  listRepositoriesHandler,
} from "@/server/repositories/handlers";
import { apiRequest, createSignedInUser } from "../helpers/auth";
import { createTestDb } from "../helpers/db";
import { json, mockFetch, type RecordedRequest } from "../helpers/fetch-mock";

const API = "https://api.github.com";
let db: Db;
let close: () => Promise<void>;
let env: Env;
let deps: AuthDeps;
let repoIdSeq = 7_000_000;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = { ...getEnv(), GITHUB_WEBHOOK_URL: "https://bot.example.com/api/webhooks/github" };
  deps = { db, env };
});
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());

function githubRepo(owner: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id: ++repoIdSeq,
    name,
    full_name: `${owner}/${name}`,
    private: false,
    archived: false,
    html_url: `https://github.com/${owner}/${name}`,
    description: null,
    owner: { login: owner },
    permissions: { admin: true, push: true, pull: true },
    pushed_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

/** GitHub fake for one repository; records hook creations/deletions. */
function githubFor(
  repo: ReturnType<typeof githubRepo>,
  opts: { hookStatus?: number; hookBody?: unknown } = {},
) {
  const base = `${API}/repos/${repo.full_name}`;
  return mockFetch({
    [`GET ${base}`]: () => json(repo),
    [`POST ${base}/hooks`]: () => json(opts.hookBody ?? { id: 555 }, opts.hookStatus ?? 201),
    [`DELETE ${base}/hooks/555`]: () => new Response(null, { status: 204 }),
  });
}

const hookCreations = (calls: RecordedRequest[]) =>
  calls.filter((c) => c.method === "POST" && c.url.pathname.endsWith("/hooks"));

async function connect(cookie: string, fullName: string) {
  return connectRepositoryHandler(
    apiRequest(env, "POST", "/api/repositories", { cookie, body: { fullName } }),
    deps,
  );
}

describe("POST /api/repositories (connect)", () => {
  it("verifies access on GitHub, installs a JSON webhook with our secret, and stores the repo", async () => {
    const alice = await createSignedInUser(db, env, "alice-connect");
    const repo = githubRepo("alice-connect", "demo");
    const gh = githubFor(repo);

    const res = await connect(alice.cookie, "alice-connect/demo");
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.repository).toMatchObject({
      fullName: "alice-connect/demo",
      webhookInstalled: true,
      private: false,
    });
    // Never exposes the webhook id's secret or any token.
    expect(JSON.stringify(body)).not.toContain(env.GITHUB_WEBHOOK_SECRET);

    const hookCall = hookCreations(gh.calls)[0]!;
    expect(hookCall.headers.get("authorization")).toBe(`Bearer ${alice.githubToken}`);
    const hook = JSON.parse(hookCall.body);
    expect(hook).toMatchObject({
      name: "web",
      active: true,
      events: ["issues", "pull_request"],
      config: {
        url: "https://bot.example.com/api/webhooks/github",
        content_type: "json",
        secret: env.GITHUB_WEBHOOK_SECRET,
        insecure_ssl: "0",
      },
    });

    const [row] = await db.select().from(repositories).where(eq(repositories.githubRepoId, repo.id));
    expect(row).toMatchObject({
      userId: alice.user.id,
      active: true,
      webhookId: 555,
      fullName: "alice-connect/demo",
    });
  });

  it("is idempotent: connecting the same repo again creates no second webhook", async () => {
    const u = await createSignedInUser(db, env, "idem-user");
    const repo = githubRepo("idem-user", "again");
    const gh = githubFor(repo);
    expect((await connect(u.cookie, "idem-user/again")).status).toBe(201);
    const second = await connect(u.cookie, "idem-user/again");
    expect(second.status).toBe(200);
    expect(hookCreations(gh.calls)).toHaveLength(1);
    expect(await db.select().from(repositories).where(eq(repositories.githubRepoId, repo.id))).toHaveLength(
      1,
    );
  });

  it("reuses and repairs an existing hook with our URL instead of failing (422 already exists)", async () => {
    const u = await createSignedInUser(db, env, "reuse-user");
    const repo = githubRepo("reuse-user", "has-hook");
    const base = `${API}/repos/${repo.full_name}`;
    const gh = mockFetch({
      [`GET ${base}`]: () => json(repo),
      [`POST ${base}/hooks`]: () =>
        json(
          {
            message: "Validation Failed",
            errors: [{ resource: "Hook", code: "custom", message: "Hook already exists on this repository" }],
          },
          422,
        ),
      [`GET ${base}/hooks`]: () =>
        json([
          { id: 111, config: { url: "https://someone-else.example/hook" } },
          { id: 222, config: { url: "https://bot.example.com/api/webhooks/github" } },
        ]),
      [`PATCH ${base}/hooks/222`]: () => json({ id: 222 }),
    });

    const res = await connect(u.cookie, "reuse-user/has-hook");
    expect(res.status).toBe(201);
    const patch = gh.calls.find((c) => c.method === "PATCH")!;
    // GitHub drops the secret on PATCH unless re-sent, so it must be included.
    expect(JSON.parse(patch.body).config.secret).toBe(env.GITHUB_WEBHOOK_SECRET);
    const [row] = await db.select().from(repositories).where(eq(repositories.githubRepoId, repo.id));
    expect(row!.webhookId).toBe(222);
  });

  it("refuses a repository already connected by another account, without touching GitHub hooks", async () => {
    const owner = await createSignedInUser(db, env, "first-owner");
    const other = await createSignedInUser(db, env, "second-user");
    const repo = githubRepo("shared-org", "shared");
    const gh = githubFor(repo);
    expect((await connect(owner.cookie, "shared-org/shared")).status).toBe(201);

    const res = await connect(other.cookie, "shared-org/shared");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("repository_connected_elsewhere");
    expect(hookCreations(gh.calls)).toHaveLength(1); // only the first owner's
  });

  it("requires admin permission and does not create a hook otherwise", async () => {
    const u = await createSignedInUser(db, env, "not-admin");
    const repo = githubRepo("someorg", "contrib", { permissions: { admin: false, push: true } });
    const gh = githubFor(repo);
    const res = await connect(u.cookie, "someorg/contrib");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("insufficient_permission");
    expect(hookCreations(gh.calls)).toHaveLength(0);
  });

  it("rejects private and archived repositories", async () => {
    const u = await createSignedInUser(db, env, "priv-user");
    githubFor(githubRepo("priv-user", "secret", { private: true }));
    const priv = await connect(u.cookie, "priv-user/secret");
    expect(priv.status).toBe(422);
    expect((await priv.json()).error.code).toBe("private_repository_unsupported");

    githubFor(githubRepo("priv-user", "old", { archived: true }));
    const archived = await connect(u.cookie, "priv-user/old");
    expect((await archived.json()).error.code).toBe("repository_archived");
  });

  it("returns 404 when GitHub says the repository does not exist or is not visible", async () => {
    const u = await createSignedInUser(db, env, "missing-user");
    mockFetch({ [`GET ${API}/repos/missing-user/nope`]: () => json({ message: "Not Found" }, 404) });
    const res = await connect(u.cookie, "missing-user/nope");
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("repository_not_found");
  });

  it("surfaces GitHub's validation reason when the webhook is rejected, and stores nothing", async () => {
    const u = await createSignedInUser(db, env, "reject-user");
    const repo = githubRepo("reject-user", "local");
    githubFor(repo, {
      hookStatus: 422,
      hookBody: {
        message: "Validation Failed",
        errors: [
          { resource: "Hook", code: "custom", message: "Sorry, the URL host localhost is not supported" },
        ],
      },
    });
    const res = await connect(u.cookie, "reject-user/local");
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("localhost is not supported");
    expect(await db.select().from(repositories).where(eq(repositories.githubRepoId, repo.id))).toHaveLength(
      0,
    );
  });

  it("maps a GitHub outage to 502 and stores nothing", async () => {
    const u = await createSignedInUser(db, env, "outage-user");
    const repo = githubRepo("outage-user", "down");
    githubFor(repo, { hookStatus: 500, hookBody: { message: "Server Error" } });
    const res = await connect(u.cookie, "outage-user/down");
    expect(res.status).toBe(502);
    expect(await db.select().from(repositories).where(eq(repositories.githubRepoId, repo.id))).toHaveLength(
      0,
    );
  });

  it("asks the user to sign in again when their GitHub authorization is flagged", async () => {
    const u = await createSignedInUser(db, env, "reauth-user");
    await db.update(users).set({ githubReauthRequiredAt: new Date() }).where(eq(users.id, u.user.id));
    const gh = mockFetch({});
    const res = await connect(u.cookie, "reauth-user/any");
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("github_reauth_required");
    expect(gh.calls).toHaveLength(0);
  });

  it("validates input, authentication and origin", async () => {
    const u = await createSignedInUser(db, env, "validation-user");
    const gh = mockFetch({});
    const bad = await connect(u.cookie, "not a repo name");
    expect(bad.status).toBe(400);
    const traversal = await connect(u.cookie, "../../etc/passwd");
    expect(traversal.status).toBe(400);
    const malformed = await connectRepositoryHandler(
      apiRequest(env, "POST", "/api/repositories", { cookie: u.cookie, body: "{not json" }),
      deps,
    );
    expect(malformed.status).toBe(400);
    const anon = await connectRepositoryHandler(
      apiRequest(env, "POST", "/api/repositories", { body: { fullName: "a/b" } }),
      deps,
    );
    expect(anon.status).toBe(401);
    const crossSite = await connectRepositoryHandler(
      apiRequest(env, "POST", "/api/repositories", {
        cookie: u.cookie,
        body: { fullName: "a/b" },
        origin: "https://evil.example",
      }),
      deps,
    );
    expect(crossSite.status).toBe(403);
    expect(gh.calls).toHaveLength(0);
  });
});

describe("authorization: users only ever see and change their own repositories", () => {
  it("lists only the caller's repositories and hides another user's by id", async () => {
    const a = await createSignedInUser(db, env, "authz-a");
    const b = await createSignedInUser(db, env, "authz-b");
    githubFor(githubRepo("authz-a", "a-repo"));
    await connect(a.cookie, "authz-a/a-repo");
    githubFor(githubRepo("authz-b", "b-repo"));
    const bRes = await connect(b.cookie, "authz-b/b-repo");
    const bRepoId = (await bRes.json()).repository.id as string;

    const listA = await (
      await listRepositoriesHandler(apiRequest(env, "GET", "/api/repositories", { cookie: a.cookie }), deps)
    ).json();
    expect(listA.repositories.map((r: { fullName: string }) => r.fullName)).toEqual(["authz-a/a-repo"]);

    // Own repository: visible.
    const own = await getRepositoryHandler(
      apiRequest(env, "GET", `/api/repositories/${bRepoId}`, { cookie: b.cookie }),
      deps,
      bRepoId,
    );
    expect(own.status).toBe(200);
    // Someone else's: indistinguishable from non-existent.
    const foreign = await getRepositoryHandler(
      apiRequest(env, "GET", `/api/repositories/${bRepoId}`, { cookie: a.cookie }),
      deps,
      bRepoId,
    );
    expect(foreign.status).toBe(404);
    const nonexistent = await getRepositoryHandler(
      apiRequest(env, "GET", "/api/repositories/00000000-0000-4000-8000-000000000000", { cookie: a.cookie }),
      deps,
      "00000000-0000-4000-8000-000000000000",
    );
    expect(nonexistent.status).toBe(404);
    expect(await foreign.json()).toEqual(await nonexistent.json());
  });

  it("does not let user A disconnect user B's repository", async () => {
    const a = await createSignedInUser(db, env, "authz-del-a");
    const b = await createSignedInUser(db, env, "authz-del-b");
    githubFor(githubRepo("authz-del-b", "keep"));
    const bRepoId = (await (await connect(b.cookie, "authz-del-b/keep")).json()).repository.id as string;

    const gh = mockFetch({});
    const res = await disconnectRepositoryHandler(
      apiRequest(env, "DELETE", `/api/repositories/${bRepoId}`, { cookie: a.cookie }),
      deps,
      bRepoId,
    );
    expect(res.status).toBe(404);
    expect(gh.calls).toHaveLength(0); // B's webhook was never touched
    const [row] = await db.select().from(repositories).where(eq(repositories.id, bRepoId));
    expect(row!.active).toBe(true);
  });

  it("treats malformed ids as not found", async () => {
    const a = await createSignedInUser(db, env, "authz-bad-id");
    const res = await getRepositoryHandler(
      apiRequest(env, "GET", "/api/repositories/1 OR 1=1", { cookie: a.cookie }),
      deps,
      "1 OR 1=1",
    );
    expect(res.status).toBe(404);
  });

  it("requires authentication to list", async () => {
    const res = await listRepositoriesHandler(apiRequest(env, "GET", "/api/repositories"), deps);
    expect(res.status).toBe(401);
  });
});

describe("DELETE /api/repositories/:id (disconnect)", () => {
  it("removes the webhook on GitHub and deactivates the repository", async () => {
    const u = await createSignedInUser(db, env, "disc-user");
    const repo = githubRepo("disc-user", "bye");
    const gh = githubFor(repo);
    const id = (await (await connect(u.cookie, "disc-user/bye")).json()).repository.id as string;

    const res = await disconnectRepositoryHandler(
      apiRequest(env, "DELETE", `/api/repositories/${id}`, { cookie: u.cookie }),
      deps,
      id,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ webhookRemoved: true });
    expect(gh.calls.some((c) => c.method === "DELETE" && c.url.pathname.endsWith("/hooks/555"))).toBe(true);
    const [row] = await db.select().from(repositories).where(eq(repositories.id, id));
    expect(row).toMatchObject({ active: false, webhookId: null });

    // Now another user may connect it.
    const other = await createSignedInUser(db, env, "disc-next");
    githubFor(repo);
    expect((await connect(other.cookie, "disc-user/bye")).status).toBe(201);
  });

  it("treats an already-deleted webhook (404) as success", async () => {
    const u = await createSignedInUser(db, env, "disc-404");
    const repo = githubRepo("disc-404", "gone");
    githubFor(repo);
    const id = (await (await connect(u.cookie, "disc-404/gone")).json()).repository.id as string;
    mockFetch({ [`DELETE ${API}/repos/disc-404/gone/hooks/555`]: () => json({ message: "Not Found" }, 404) });
    const res = await disconnectRepositoryHandler(
      apiRequest(env, "DELETE", `/api/repositories/${id}`, { cookie: u.cookie }),
      deps,
      id,
    );
    expect(await res.json()).toEqual({ webhookRemoved: true });
  });

  it("still disconnects but reports honestly when GitHub cannot remove the webhook", async () => {
    const u = await createSignedInUser(db, env, "disc-fail");
    const repo = githubRepo("disc-fail", "stuck");
    githubFor(repo);
    const id = (await (await connect(u.cookie, "disc-fail/stuck")).json()).repository.id as string;
    mockFetch({
      [`DELETE ${API}/repos/disc-fail/stuck/hooks/555`]: () => json({ message: "Server Error" }, 500),
    });
    const res = await disconnectRepositoryHandler(
      apiRequest(env, "DELETE", `/api/repositories/${id}`, { cookie: u.cookie }),
      deps,
      id,
    );
    const body = await res.json();
    expect(body.webhookRemoved).toBe(false);
    expect(body.warning).toMatch(/could not be removed/);
    const [row] = await db
      .select()
      .from(repositories)
      .where(and(eq(repositories.id, id), eq(repositories.active, false)));
    expect(row!.webhookId).toBe(555); // kept for diagnosis
  });
});

describe("GET /api/github/repositories (connectable list)", () => {
  it("returns only public, non-archived repos the user administers, marking connected ones", async () => {
    const u = await createSignedInUser(db, env, "list-user");
    const connectedRepo = githubRepo("list-user", "connected-one");
    githubFor(connectedRepo);
    await connect(u.cookie, "list-user/connected-one");

    const gh = mockFetch({
      [`GET ${API}/user/repos`]: () =>
        json([
          connectedRepo,
          githubRepo("list-user", "admin-public"),
          githubRepo("list-user", "private-one", { private: true }),
          githubRepo("list-user", "archived-one", { archived: true }),
          githubRepo("other", "no-admin", { permissions: { admin: false, push: true } }),
        ]),
    });
    const res = await listConnectableHandler(
      apiRequest(env, "GET", "/api/github/repositories", { cookie: u.cookie }),
      deps,
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.repositories.map((r: { fullName: string }) => r.fullName)).toEqual([
      "list-user/connected-one",
      "list-user/admin-public",
    ]);
    expect(body.repositories[0].connected).toBe(true);
    expect(body.repositories[1].connected).toBe(false);
    expect(body.webhookUrl).toBe("https://bot.example.com/api/webhooks/github");

    const q = gh.calls[0]!.url.searchParams;
    expect(q.get("visibility")).toBe("public");
    expect(q.get("per_page")).toBe("100");
  });
});
