import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  handleGitHubCallback,
  handleLogout,
  handleMe,
  startGitHubLogin,
  type AuthDeps,
} from "@/server/auth/handlers";
import { oauthCookieName, sessionCookieName } from "@/server/auth/session";
import { sha256Hex, decryptSecret } from "@/server/crypto";
import type { Db } from "@/server/db";
import { sessions, users } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import { createTestDb } from "../helpers/db";
import { json, mockFetch } from "../helpers/fetch-mock";

const TOKEN_URL = "POST https://github.com/login/oauth/access_token";
const USER_URL = "GET https://api.github.com/user";
const EMAILS_URL = "GET https://api.github.com/user/emails";
const FAKE_TOKEN = "gho_fake_token_for_tests_only";

let db: Db;
let close: () => Promise<void>;
let env: Env;
let deps: AuthDeps;
let ipCounter = 0;
/** Unique IP per test so the (real, DB-backed) rate limiter doesn't couple tests. */
const nextIp = () => `203.0.113.${++ipCounter}`;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv();
  deps = { db, env };
});
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());

function githubHappyPath(overrides: { email?: string | null; githubId?: number; login?: string } = {}) {
  return mockFetch({
    [TOKEN_URL]: () =>
      json({ access_token: FAKE_TOKEN, token_type: "bearer", scope: "public_repo,read:user,user:email" }),
    [USER_URL]: () =>
      json({
        id: overrides.githubId ?? 1001,
        login: overrides.login ?? "octo-tester",
        name: "Octo Tester",
        email: overrides.email === undefined ? "octo@example.com" : overrides.email,
        avatar_url: "https://avatars.githubusercontent.com/u/1001",
      }),
    [EMAILS_URL]: () =>
      json([
        { email: "secondary@example.com", primary: false, verified: true, visibility: null },
        { email: "primary@example.com", primary: true, verified: true, visibility: "private" },
      ]),
  });
}

async function start(ip = nextIp(), d: AuthDeps = deps) {
  const res = await startGitHubLogin(
    new NextRequest(`${d.env.APP_URL}/api/auth/github`, { headers: { "x-forwarded-for": ip } }),
    d,
  );
  const location = new URL(res.headers.get("location")!);
  const cookieValue = res.cookies.get(oauthCookieName(d.env))?.value ?? "";
  return { res, location, cookieValue, state: location.searchParams.get("state") ?? "" };
}

function callbackRequest(query: string, cookies: Record<string, string>, ip = nextIp(), d: AuthDeps = deps) {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(`${d.env.APP_URL}/api/auth/github/callback?${query}`, {
    headers: { cookie, "x-forwarded-for": ip },
  });
}

async function login(overrides?: Parameters<typeof githubHappyPath>[0]) {
  const fetchMock = githubHappyPath(overrides);
  const s = await start();
  const res = await handleGitHubCallback(
    callbackRequest(`code=good-code&state=${s.state}`, { [oauthCookieName(env)]: s.cookieValue }),
    deps,
  );
  vi.unstubAllGlobals();
  return { res, fetchMock, sessionToken: res.cookies.get(sessionCookieName(env))?.value ?? "" };
}

function locationOf(res: Response) {
  return new URL(res.headers.get("location")!);
}

describe("GET /api/auth/github (start)", () => {
  it("redirects to GitHub with state, PKCE S256 challenge, scopes and exact callback", async () => {
    const { res, location, cookieValue, state } = await start();
    expect(res.status).toBe(302);
    expect(location.origin + location.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(location.searchParams.get("client_id")).toBe(env.GITHUB_CLIENT_ID);
    expect(location.searchParams.get("redirect_uri")).toBe(`${env.APP_URL}/api/auth/github/callback`);
    expect(location.searchParams.get("scope")).toBe("read:user user:email public_repo");
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // The cookie holds state + verifier; the URL holds state + SHA-256(verifier).
    const [cookieState, verifier] = cookieValue.split(".");
    expect(cookieState).toBe(state);
    const expectedChallenge = createHash("sha256").update(verifier!).digest("base64url");
    expect(location.searchParams.get("code_challenge")).toBe(expectedChallenge);
    // The verifier itself must never appear in the redirect URL.
    expect(location.toString()).not.toContain(verifier!);
    // Client secret never goes to the browser.
    expect(location.toString()).not.toContain(env.GITHUB_CLIENT_SECRET);
  });

  it("sets the state cookie HttpOnly, SameSite=Lax, scoped to the auth path, short-lived", async () => {
    const { res } = await start();
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${oauthCookieName(env)}=`))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Path=\/api\/auth\/github/);
    expect(setCookie).toMatch(/Max-Age=600/);
  });

  it("generates a different state for every attempt", async () => {
    const a = await start();
    const b = await start();
    expect(a.state).not.toBe(b.state);
  });

  it("rate limits repeated starts from the same IP", async () => {
    const ip = nextIp();
    for (let i = 0; i < 30; i++) expect((await start(ip)).res.status).toBe(302);
    const limited = await startGitHubLogin(
      new NextRequest(`${env.APP_URL}/api/auth/github`, { headers: { "x-forwarded-for": ip } }),
      deps,
    );
    expect(limited.status).toBe(303);
    expect(locationOf(limited).searchParams.get("error")).toBe("rate_limited");
  });
});

describe("GET /api/auth/github/callback", () => {
  it("happy path: exchanges code with PKCE verifier, creates user + session, redirects to dashboard", async () => {
    const fetchMock = githubHappyPath();
    const s = await start();
    const verifier = s.cookieValue.split(".")[1]!;
    const res = await handleGitHubCallback(
      callbackRequest(`code=good-code&state=${s.state}`, { [oauthCookieName(env)]: s.cookieValue }),
      deps,
    );

    expect(res.status).toBe(303);
    expect(locationOf(res).toString()).toBe(`${env.APP_URL}/dashboard`);

    // Token exchange was a server-side POST carrying the code, verifier and secret.
    const tokenCall = fetchMock.calls.find((c) => c.url.hostname === "github.com")!;
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get("code")).toBe("good-code");
    expect(form.get("code_verifier")).toBe(verifier);
    expect(form.get("client_secret")).toBe(env.GITHUB_CLIENT_SECRET);
    expect(form.get("redirect_uri")).toBe(`${env.APP_URL}/api/auth/github/callback`);
    expect(tokenCall.headers.get("accept")).toBe("application/json");

    // The GitHub API call used the token as a Bearer credential.
    const userCall = fetchMock.calls.find((c) => c.url.pathname === "/user")!;
    expect(userCall.headers.get("authorization")).toBe(`Bearer ${FAKE_TOKEN}`);

    // User stored with an encrypted token (never plaintext).
    const [user] = await db.select().from(users).where(eq(users.githubUserId, 1001));
    expect(user!.githubLogin).toBe("octo-tester");
    expect(user!.accessTokenEnc).not.toContain(FAKE_TOKEN);
    expect(decryptSecret(user!.accessTokenEnc, env.TOKEN_ENCRYPTION_KEY)).toBe(FAKE_TOKEN);
    expect(user!.tokenScopes).toBe("public_repo,read:user,user:email");

    // Session cookie is HttpOnly/Lax/Path=/, and only its hash is stored.
    const sessionToken = res.cookies.get(sessionCookieName(env))!.value;
    const setCookie = res.headers.getSetCookie().find((c) => c.startsWith(`${sessionCookieName(env)}=`))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=lax/i);
    expect(setCookie).toMatch(/Path=\//);
    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sha256Hex(sessionToken)));
    expect(row!.userId).toBe(user!.id);
    const raw = await db.select().from(sessions).where(eq(sessions.id, sessionToken));
    expect(raw).toHaveLength(0);

    // The one-time OAuth cookie is cleared.
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${oauthCookieName(env)}=`))!;
    expect(cleared).toMatch(/Max-Age=0/);

    // Nothing sensitive in the redirect.
    expect(res.headers.get("location")).not.toContain(FAKE_TOKEN);
  });

  it("rejects a state that does not match the cookie (CSRF) without calling GitHub", async () => {
    const fetchMock = githubHappyPath();
    const s = await start();
    const res = await handleGitHubCallback(
      callbackRequest(`code=good-code&state=attacker-state`, { [oauthCookieName(env)]: s.cookieValue }),
      deps,
    );
    expect(res.status).toBe(303);
    expect(locationOf(res).pathname).toBe("/login");
    expect(locationOf(res).searchParams.get("error")).toBe("invalid_state");
    expect(fetchMock.calls).toHaveLength(0);
    expect(res.cookies.get(sessionCookieName(env))).toBeUndefined();
  });

  it("rejects a callback when the state cookie is missing (e.g. attacker-initiated link)", async () => {
    const fetchMock = githubHappyPath();
    const s = await start();
    const res = await handleGitHubCallback(callbackRequest(`code=good-code&state=${s.state}`, {}), deps);
    expect(locationOf(res).searchParams.get("error")).toBe("invalid_state");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("rejects a malformed state cookie", async () => {
    const s = await start();
    const res = await handleGitHubCallback(
      callbackRequest(`code=good-code&state=${s.state}`, { [oauthCookieName(env)]: `${s.state}` }),
      deps,
    );
    expect(locationOf(res).searchParams.get("error")).toBe("invalid_state");
  });

  it("handles the user cancelling on GitHub (error=access_denied)", async () => {
    const fetchMock = githubHappyPath();
    const s = await start();
    const res = await handleGitHubCallback(
      callbackRequest(`error=access_denied&error_description=denied&state=${s.state}`, {
        [oauthCookieName(env)]: s.cookieValue,
      }),
      deps,
    );
    expect(locationOf(res).searchParams.get("error")).toBe("access_denied");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("maps other GitHub callback errors (e.g. redirect_uri_mismatch) to a generic failure", async () => {
    const s = await start();
    const res = await handleGitHubCallback(
      callbackRequest(`error=redirect_uri_mismatch&state=${s.state}`, {
        [oauthCookieName(env)]: s.cookieValue,
      }),
      deps,
    );
    expect(locationOf(res).searchParams.get("error")).toBe("oauth_failed");
  });

  it("fails when the code is missing", async () => {
    const s = await start();
    const res = await handleGitHubCallback(
      callbackRequest(`state=${s.state}`, { [oauthCookieName(env)]: s.cookieValue }),
      deps,
    );
    expect(locationOf(res).searchParams.get("error")).toBe("oauth_failed");
  });

  it("treats a token-endpoint error body (HTTP 200) as failure and creates no user", async () => {
    mockFetch({
      [TOKEN_URL]: () =>
        json({
          error: "bad_verification_code",
          error_description: "The code passed is incorrect or expired.",
        }),
    });
    const s = await start();
    const before = await db.select().from(users);
    const res = await handleGitHubCallback(
      callbackRequest(`code=expired&state=${s.state}`, { [oauthCookieName(env)]: s.cookieValue }),
      deps,
    );
    expect(locationOf(res).searchParams.get("error")).toBe("oauth_failed");
    expect(res.cookies.get(sessionCookieName(env))).toBeUndefined();
    expect(await db.select().from(users)).toHaveLength(before.length);
  });

  it("fails cleanly when GitHub /user returns 401", async () => {
    mockFetch({
      [TOKEN_URL]: () => json({ access_token: FAKE_TOKEN, token_type: "bearer", scope: "read:user" }),
      [USER_URL]: () => json({ message: "Bad credentials" }, 401),
    });
    const s = await start();
    const res = await handleGitHubCallback(
      callbackRequest(`code=good&state=${s.state}`, { [oauthCookieName(env)]: s.cookieValue }),
      deps,
    );
    expect(locationOf(res).searchParams.get("error")).toBe("oauth_failed");
    expect(res.cookies.get(sessionCookieName(env))).toBeUndefined();
  });

  it("fails cleanly when GitHub is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const s = await start();
    const res = await handleGitHubCallback(
      callbackRequest(`code=good&state=${s.state}`, { [oauthCookieName(env)]: s.cookieValue }),
      deps,
    );
    expect(locationOf(res).searchParams.get("error")).toBe("oauth_failed");
  });

  it("updates the existing user on repeat login instead of creating a duplicate", async () => {
    await login({ githubId: 2002, login: "old-name" });
    await login({ githubId: 2002, login: "new-name" });
    const rows = await db.select().from(users).where(eq(users.githubUserId, 2002));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.githubLogin).toBe("new-name");
  });

  it("falls back to the primary verified email when the profile email is private", async () => {
    await login({ githubId: 3003, email: null });
    const [row] = await db.select().from(users).where(eq(users.githubUserId, 3003));
    expect(row!.email).toBe("primary@example.com");
  });

  it("invalidates the browser's previous session when logging in again", async () => {
    const first = await login({ githubId: 4004 });
    githubHappyPath({ githubId: 4004 });
    const s = await start();
    const res = await handleGitHubCallback(
      callbackRequest(`code=good&state=${s.state}`, {
        [oauthCookieName(env)]: s.cookieValue,
        [sessionCookieName(env)]: first.sessionToken,
      }),
      deps,
    );
    expect(res.status).toBe(303);
    const old = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, sha256Hex(first.sessionToken)));
    expect(old).toHaveLength(0);
  });
});

describe("GET /api/auth/me", () => {
  const meRequest = (cookie?: string) =>
    new NextRequest(`${env.APP_URL}/api/auth/me`, { headers: cookie ? { cookie } : {} });

  it("returns the signed-in user without any token material", async () => {
    const { sessionToken } = await login({ githubId: 5005, login: "me-user" });
    const res = await handleMe(meRequest(`${sessionCookieName(env)}=${sessionToken}`), deps);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.githubLogin).toBe("me-user");
    expect(Object.keys(body.user).sort()).toEqual(["avatarUrl", "email", "githubLogin", "id", "name"]);
    expect(JSON.stringify(body)).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(body)).not.toContain("accessToken");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 401 without a cookie", async () => {
    const res = await handleMe(meRequest(), deps);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthenticated");
  });

  it("returns 401 for a forged or malformed session token", async () => {
    const forged = "A".repeat(43);
    expect((await handleMe(meRequest(`${sessionCookieName(env)}=${forged}`), deps)).status).toBe(401);
    expect((await handleMe(meRequest(`${sessionCookieName(env)}=not-a-token`), deps)).status).toBe(401);
  });

  it("returns 401 for an expired session", async () => {
    const { sessionToken } = await login({ githubId: 6006 });
    await db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.id, sha256Hex(sessionToken)));
    expect((await handleMe(meRequest(`${sessionCookieName(env)}=${sessionToken}`), deps)).status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  const logoutRequest = (headers: Record<string, string>) =>
    new NextRequest(`${env.APP_URL}/api/auth/logout`, { method: "POST", headers });

  it("deletes the session, clears the cookie and redirects to /login", async () => {
    const { sessionToken } = await login({ githubId: 7007 });
    const res = await handleLogout(
      logoutRequest({ origin: env.APP_URL, cookie: `${sessionCookieName(env)}=${sessionToken}` }),
      deps,
    );
    expect(res.status).toBe(303);
    expect(locationOf(res).pathname).toBe("/login");
    const cleared = res.headers.getSetCookie().find((c) => c.startsWith(`${sessionCookieName(env)}=`))!;
    expect(cleared).toMatch(/Max-Age=0/);
    expect(
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sha256Hex(sessionToken))),
    ).toHaveLength(0);

    // The old cookie no longer authenticates.
    const me = await handleMe(
      new NextRequest(`${env.APP_URL}/api/auth/me`, {
        headers: { cookie: `${sessionCookieName(env)}=${sessionToken}` },
      }),
      deps,
    );
    expect(me.status).toBe(401);
  });

  it("rejects cross-origin logout attempts and keeps the session", async () => {
    const { sessionToken } = await login({ githubId: 8008 });
    const cookie = `${sessionCookieName(env)}=${sessionToken}`;
    const evil = await handleLogout(logoutRequest({ origin: "https://evil.example", cookie }), deps);
    expect(evil.status).toBe(403);
    const noOrigin = await handleLogout(logoutRequest({ cookie }), deps);
    expect(noOrigin.status).toBe(403);
    expect(
      await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, sha256Hex(sessionToken))),
    ).toHaveLength(1);
  });

  it("is idempotent when there is no session", async () => {
    const res = await handleLogout(logoutRequest({ origin: env.APP_URL }), deps);
    expect(res.status).toBe(303);
  });
});

describe("production cookie hardening (https APP_URL)", () => {
  it("uses Secure + __Host- prefixed session cookie and Secure state cookie", async () => {
    const httpsDeps: AuthDeps = { db, env: { ...env, APP_URL: "https://bot.example.com" } };
    githubHappyPath({ githubId: 9009 });
    const s = await start(nextIp(), httpsDeps);
    expect(oauthCookieName(httpsDeps.env)).toBe("__Secure-gh_oauth");
    const stateCookie = s.res.headers.getSetCookie().find((c) => c.startsWith("__Secure-gh_oauth="))!;
    expect(stateCookie).toMatch(/Secure/);

    const res = await handleGitHubCallback(
      callbackRequest(
        `code=good&state=${s.state}`,
        { "__Secure-gh_oauth": s.cookieValue },
        nextIp(),
        httpsDeps,
      ),
      httpsDeps,
    );
    const sessionCookie = res.headers.getSetCookie().find((c) => c.startsWith("__Host-session="))!;
    expect(sessionCookie).toMatch(/Secure/);
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/Path=\//);
    expect(sessionCookie).not.toMatch(/Domain=/i);
    expect(locationOf(res).toString()).toBe("https://bot.example.com/dashboard");
  });
});
