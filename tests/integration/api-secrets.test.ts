import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AuthDeps } from "@/server/auth/handlers";
import { handleMe } from "@/server/auth/handlers";
import type { Executors } from "@/server/automation/executors";
import { processEvent } from "@/server/automation/process-event";
import type { Db } from "@/server/db";
import { repositories, users } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import { getEventHandler, listEventsHandler, statsHandler } from "@/server/events/handlers";
import {
  connectRepositoryHandler,
  getRepositoryHandler,
  listConnectableHandler,
  listRepositoriesHandler,
} from "@/server/repositories/handlers";
import { createRuleHandler, listRulesHandler } from "@/server/rules/handlers";
import { getSlackSettingsHandler, saveSlackSettingsHandler } from "@/server/slack/handlers";
import { apiRequest, createSignedInUser } from "../helpers/auth";
import { createTestDb } from "../helpers/db";
import { json, mockFetch } from "../helpers/fetch-mock";
import { createEvent } from "../helpers/fixtures";

const SLACK_HOOK = "https://hooks.slack.com/services/TSECRET/BSECRET/secretsecretsecret";

let db: Db;
let close: () => Promise<void>;
let env: Env;
let deps: AuthDeps;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv();
  deps = { db, env };
});
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());

describe("browser-facing API responses never contain tokens or secrets", () => {
  it("covers every dashboard endpoint for a user with a repository, rule, event and Slack webhook", async () => {
    const u = await createSignedInUser(db, env, "secrets-user");
    const repo = {
      id: 8_800_001,
      name: "sandbox",
      full_name: "secrets-user/sandbox",
      private: false,
      archived: false,
      html_url: "https://github.com/secrets-user/sandbox",
      description: null,
      owner: { login: "secrets-user" },
      permissions: { admin: true, push: true, pull: true },
      pushed_at: "2026-09-01T00:00:00Z",
    };
    mockFetch({
      "GET https://api.github.com/repos/secrets-user/sandbox": () => json(repo),
      "POST https://api.github.com/repos/secrets-user/sandbox/hooks": () => json({ id: 4242 }, 201),
      "GET https://api.github.com/user/repos": () => json([repo]),
    });

    const bodies: Array<[string, string]> = [];
    const record = async (name: string, res: Response) => {
      expect(res.status, name).toBeLessThan(300);
      bodies.push([name, await res.text()]);
    };
    const get = (path: string) => apiRequest(env, "GET", path, { cookie: u.cookie });

    await record(
      "POST /api/repositories",
      await connectRepositoryHandler(
        apiRequest(env, "POST", "/api/repositories", {
          cookie: u.cookie,
          body: { fullName: "secrets-user/sandbox" },
        }),
        deps,
      ),
    );
    const [stored] = await db.select().from(repositories).where(eq(repositories.userId, u.user.id));
    await record(
      "PUT /api/settings/slack",
      await saveSlackSettingsHandler(
        apiRequest(env, "PUT", "/api/settings/slack", { cookie: u.cookie, body: { webhookUrl: SLACK_HOOK } }),
        deps,
      ),
    );
    await record(
      "POST /api/rules",
      await createRuleHandler(
        apiRequest(env, "POST", "/api/rules", {
          cookie: u.cookie,
          body: {
            repositoryId: stored!.id,
            name: "Bug issue automation",
            eventType: "issues",
            keywords: ["bug"],
            actionType: "add_label",
            actionValue: "bug",
          },
        }),
        deps,
      ),
    );
    const { event } = await createEvent(db, { user: u.user, repo: stored! });
    const executors: Executors = {
      github: async () => ({ labelName: "bug", alreadyApplied: false }),
      slack: async () => ({ status: "sent" }),
      triage: async () => ({ status: "skipped", reason: "not configured" }),
    };
    await processEvent(db, env, { webhookEventId: event.id, attempt: 1, isFinalAttempt: false }, executors);

    await record("GET /api/auth/me", await handleMe(get("/api/auth/me"), deps));
    await record("GET /api/repositories", await listRepositoriesHandler(get("/api/repositories"), deps));
    await record(
      "GET /api/repositories/:id",
      await getRepositoryHandler(get(`/api/repositories/${stored!.id}`), deps, stored!.id),
    );
    await record(
      "GET /api/github/repositories",
      await listConnectableHandler(get("/api/github/repositories"), deps),
    );
    await record("GET /api/rules", await listRulesHandler(get("/api/rules"), deps));
    await record("GET /api/events", await listEventsHandler(get("/api/events"), deps));
    await record(
      "GET /api/events/:id",
      await getEventHandler(get(`/api/events/${event.id}`), deps, event.id),
    );
    await record("GET /api/stats", await statsHandler(get("/api/stats"), deps));
    await record("GET /api/settings/slack", await getSlackSettingsHandler(get("/api/settings/slack"), deps));

    const [user] = await db.select().from(users).where(eq(users.id, u.user.id));
    const secrets: Record<string, string> = {
      "GitHub access token": u.githubToken,
      "encrypted GitHub token": user!.accessTokenEnc,
      "Slack webhook URL": SLACK_HOOK,
      "encrypted Slack webhook URL": user!.slackWebhookUrlEnc!,
      "session token": u.cookie.split("=")[1]!,
      GITHUB_WEBHOOK_SECRET: env.GITHUB_WEBHOOK_SECRET,
      GITHUB_CLIENT_SECRET: env.GITHUB_CLIENT_SECRET,
      TOKEN_ENCRYPTION_KEY: env.TOKEN_ENCRYPTION_KEY,
      CRON_SECRET: env.CRON_SECRET,
    };
    expect(bodies).toHaveLength(12);
    for (const [endpoint, body] of bodies) {
      for (const [name, value] of Object.entries(secrets)) {
        expect(body.includes(value), `${endpoint} leaks the ${name}`).toBe(false);
      }
      expect(body, endpoint).not.toMatch(/accessToken|refreshToken|TokenEnc|UrlEnc|"secret"/i);
    }
  });
});
