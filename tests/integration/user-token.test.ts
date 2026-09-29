import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptSecret, encryptSecret } from "@/server/crypto";
import type { Db } from "@/server/db";
import { users } from "@/server/db/schema";
import { getEnv, type Env } from "@/server/env";
import { getUserAccessToken, GitHubReauthRequiredError } from "@/server/github/user-token";
import { createTestDb } from "../helpers/db";
import { json, mockFetch } from "../helpers/fetch-mock";

const TOKEN_URL = "POST https://github.com/login/oauth/access_token";
const HOUR = 60 * 60 * 1000;

let db: Db;
let close: () => Promise<void>;
let env: Env;
let githubId = 50_000;

beforeAll(async () => {
  ({ db, close } = await createTestDb());
  env = getEnv();
});
afterAll(async () => close());
afterEach(() => vi.unstubAllGlobals());

async function createUser(opts: {
  accessToken?: string;
  accessTokenExpiresAt?: Date | null;
  refreshToken?: string | null;
  refreshTokenExpiresAt?: Date | null;
  reauth?: boolean;
}) {
  const key = env.TOKEN_ENCRYPTION_KEY;
  const [u] = await db
    .insert(users)
    .values({
      githubUserId: ++githubId,
      githubLogin: `user-${githubId}`,
      accessTokenEnc: encryptSecret(opts.accessToken ?? "ghu_old_access", key),
      accessTokenExpiresAt: opts.accessTokenExpiresAt ?? null,
      refreshTokenEnc:
        opts.refreshToken === null ? null : encryptSecret(opts.refreshToken ?? "ghr_old_refresh", key),
      refreshTokenExpiresAt: opts.refreshTokenExpiresAt ?? null,
      githubReauthRequiredAt: opts.reauth ? new Date() : null,
    })
    .returning();
  return u!;
}

async function reload(id: string) {
  const [u] = await db.select().from(users).where(eq(users.id, id));
  return u!;
}

const refreshResponse = () =>
  json({
    access_token: "ghu_new_access",
    token_type: "bearer",
    scope: "",
    expires_in: 28_800,
    refresh_token: "ghr_new_refresh",
    refresh_token_expires_in: 15_897_600,
  });

describe("getUserAccessToken", () => {
  it("returns a non-expiring token without calling GitHub", async () => {
    const fetchMock = mockFetch({});
    const u = await createUser({
      accessToken: "gho_classic",
      accessTokenExpiresAt: null,
      refreshToken: null,
    });
    expect(await getUserAccessToken(db, env, u.id)).toBe("gho_classic");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("returns an expiring token that is still comfortably valid", async () => {
    const fetchMock = mockFetch({});
    const u = await createUser({ accessTokenExpiresAt: new Date(Date.now() + 2 * HOUR) });
    expect(await getUserAccessToken(db, env, u.id)).toBe("ghu_old_access");
    expect(fetchMock.calls).toHaveLength(0);
  });

  it("refreshes a token inside the 5-minute margin and stores the rotated pair encrypted", async () => {
    const fetchMock = mockFetch({ [TOKEN_URL]: refreshResponse });
    const u = await createUser({
      accessTokenExpiresAt: new Date(Date.now() + 60_000),
      refreshTokenExpiresAt: new Date(Date.now() + 1000 * HOUR),
    });

    expect(await getUserAccessToken(db, env, u.id)).toBe("ghu_new_access");

    const form = new URLSearchParams(fetchMock.calls[0]!.body);
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe("ghr_old_refresh");
    expect(form.get("client_id")).toBe(env.GITHUB_CLIENT_ID);
    expect(form.get("client_secret")).toBe(env.GITHUB_CLIENT_SECRET);

    const after = await reload(u.id);
    expect(after.accessTokenEnc).not.toContain("ghu_new_access");
    expect(decryptSecret(after.accessTokenEnc, env.TOKEN_ENCRYPTION_KEY)).toBe("ghu_new_access");
    expect(decryptSecret(after.refreshTokenEnc!, env.TOKEN_ENCRYPTION_KEY)).toBe("ghr_new_refresh");
    const hoursLeft = (after.accessTokenExpiresAt!.getTime() - Date.now()) / HOUR;
    expect(hoursLeft).toBeGreaterThan(7.9);
    expect(hoursLeft).toBeLessThanOrEqual(8);
  });

  it("refreshes only once when several workers need the token at the same time", async () => {
    let refreshCalls = 0;
    mockFetch({
      [TOKEN_URL]: async () => {
        refreshCalls++;
        await new Promise((r) => setTimeout(r, 20));
        return refreshResponse();
      },
    });
    const u = await createUser({ accessTokenExpiresAt: new Date(Date.now() - 1000) });

    const tokens = await Promise.all([
      getUserAccessToken(db, env, u.id),
      getUserAccessToken(db, env, u.id),
      getUserAccessToken(db, env, u.id),
    ]);
    expect(tokens).toEqual(["ghu_new_access", "ghu_new_access", "ghu_new_access"]);
    // A second refresh would have used the already-rotated (dead) refresh token.
    expect(refreshCalls).toBe(1);
  });

  it("flags the user for re-authentication on bad_refresh_token and stops calling GitHub", async () => {
    const fetchMock = mockFetch({
      [TOKEN_URL]: () =>
        json({
          error: "bad_refresh_token",
          error_description: "The refresh token passed is incorrect or expired.",
        }),
    });
    const u = await createUser({ accessTokenExpiresAt: new Date(Date.now() - 1000) });

    await expect(getUserAccessToken(db, env, u.id)).rejects.toBeInstanceOf(GitHubReauthRequiredError);
    expect((await reload(u.id)).githubReauthRequiredAt).not.toBeNull();

    // Subsequent calls fail fast without another (pointless) request to GitHub.
    await expect(getUserAccessToken(db, env, u.id)).rejects.toBeInstanceOf(GitHubReauthRequiredError);
    expect(fetchMock.calls).toHaveLength(1);
  });

  it("requires re-authentication without calling GitHub when the refresh token has expired", async () => {
    const fetchMock = mockFetch({});
    const u = await createUser({
      accessTokenExpiresAt: new Date(Date.now() - 1000),
      refreshTokenExpiresAt: new Date(Date.now() - 1000),
    });
    await expect(getUserAccessToken(db, env, u.id)).rejects.toBeInstanceOf(GitHubReauthRequiredError);
    expect(fetchMock.calls).toHaveLength(0);
    expect((await reload(u.id)).githubReauthRequiredAt).not.toBeNull();
  });

  it("requires re-authentication when an expired token has no refresh token", async () => {
    mockFetch({});
    const u = await createUser({ accessTokenExpiresAt: new Date(Date.now() - 1000), refreshToken: null });
    await expect(getUserAccessToken(db, env, u.id)).rejects.toBeInstanceOf(GitHubReauthRequiredError);
  });

  it("keeps stored tokens and surfaces a retryable error when GitHub is unreachable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    const u = await createUser({ accessTokenExpiresAt: new Date(Date.now() - 1000) });
    const err = await getUserAccessToken(db, env, u.id).catch((e) => e);
    expect(err).not.toBeInstanceOf(GitHubReauthRequiredError);
    expect(err.retryable).toBe(true);

    const after = await reload(u.id);
    expect(after.githubReauthRequiredAt).toBeNull();
    expect(decryptSecret(after.refreshTokenEnc!, env.TOKEN_ENCRYPTION_KEY)).toBe("ghr_old_refresh");
  });

  it("fails fast for a user already flagged for re-authentication", async () => {
    const fetchMock = mockFetch({});
    const u = await createUser({ reauth: true, accessTokenExpiresAt: null });
    await expect(getUserAccessToken(db, env, u.id)).rejects.toBeInstanceOf(GitHubReauthRequiredError);
    expect(fetchMock.calls).toHaveLength(0);
  });
});
