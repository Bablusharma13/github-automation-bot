import "server-only";
import { and, eq, gt } from "drizzle-orm";
import type { NextResponse } from "next/server";
import { randomToken, sha256Hex } from "../crypto";
import type { Db } from "../db";
import { sessions, users } from "../db/schema";
import type { Env } from "../env";

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
export const OAUTH_COOKIE_TTL_SECONDS = 10 * 60; // GitHub codes expire after 10 minutes
const OAUTH_COOKIE_PATH = "/api/auth/github";

/** What the rest of the app (and the browser) may know about the signed-in user. */
export type SessionUser = {
  id: string;
  githubLogin: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
};

export function usesSecureCookies(env: Pick<Env, "APP_URL">): boolean {
  return env.APP_URL.startsWith("https://");
}

/**
 * `__Host-` requires Secure, Path=/ and no Domain, which pins the cookie to this exact
 * origin. Plain HTTP localhost cannot use the prefix, so dev uses an unprefixed name.
 */
export function sessionCookieName(env: Pick<Env, "APP_URL">): string {
  return usesSecureCookies(env) ? "__Host-session" : "session";
}

export function oauthCookieName(env: Pick<Env, "APP_URL">): string {
  return usesSecureCookies(env) ? "__Secure-gh_oauth" : "gh_oauth";
}

// ---------------------------------------------------------------------------
// Session storage — only the SHA-256 of the token is stored, so a database leak does
// not yield usable session cookies.
// ---------------------------------------------------------------------------

export async function createSession(db: Db, userId: string): Promise<{ token: string; expiresAt: Date }> {
  const token = randomToken(32);
  const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
  await db.insert(sessions).values({ id: sha256Hex(token), userId, expiresAt });
  return { token, expiresAt };
}

export async function validateSessionToken(db: Db, token: string): Promise<SessionUser | null> {
  // Reject obviously malformed values without a database round-trip.
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const id = sha256Hex(token);
  const [row] = await db
    .select({
      id: users.id,
      githubLogin: users.githubLogin,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
    })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .where(and(eq(sessions.id, id), gt(sessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function invalidateSession(db: Db, token: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sha256Hex(token)));
}

// ---------------------------------------------------------------------------
// Cookies (set on the response object so handlers stay testable outside Next)
// ---------------------------------------------------------------------------

export function setSessionCookie(res: NextResponse, env: Env, token: string): void {
  res.cookies.set(sessionCookieName(env), token, {
    httpOnly: true,
    secure: usesSecureCookies(env),
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

export function clearSessionCookie(res: NextResponse, env: Env): void {
  res.cookies.set(sessionCookieName(env), "", {
    httpOnly: true,
    secure: usesSecureCookies(env),
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/**
 * The OAuth `state` and PKCE `code_verifier` travel in one short-lived HttpOnly cookie
 * scoped to the auth routes. SameSite=Lax is required: GitHub's redirect back is a
 * cross-site top-level navigation, which Lax allows and Strict would block.
 */
export function setOAuthCookie(res: NextResponse, env: Env, state: string, verifier: string): void {
  res.cookies.set(oauthCookieName(env), `${state}.${verifier}`, {
    httpOnly: true,
    secure: usesSecureCookies(env),
    sameSite: "lax",
    path: OAUTH_COOKIE_PATH,
    maxAge: OAUTH_COOKIE_TTL_SECONDS,
  });
}

export function clearOAuthCookie(res: NextResponse, env: Env): void {
  res.cookies.set(oauthCookieName(env), "", {
    httpOnly: true,
    secure: usesSecureCookies(env),
    sameSite: "lax",
    path: OAUTH_COOKIE_PATH,
    maxAge: 0,
  });
}

export function parseOAuthCookie(value: string | undefined): { state: string; verifier: string } | null {
  if (!value) return null;
  const [state, verifier, ...rest] = value.split(".");
  if (!state || !verifier || rest.length > 0) return null;
  return { state, verifier };
}
