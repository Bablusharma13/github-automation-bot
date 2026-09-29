import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { randomToken, safeEqual } from "../crypto";
import type { Db } from "../db";
import type { Env } from "../env";
import { buildAuthorizeUrl, callbackUrl, createPkcePair } from "../github/oauth";
import { jsonError } from "../http/errors";
import { clientIp, isSameOrigin } from "../http/request";
import { logger, serializeError } from "../logger";
import { consumeRateLimit } from "../rate-limit";
import { completeGitHubLogin } from "./login";
import {
  clearOAuthCookie,
  clearSessionCookie,
  invalidateSession,
  oauthCookieName,
  parseOAuthCookie,
  sessionCookieName,
  setOAuthCookie,
  setSessionCookie,
  validateSessionToken,
  type SessionUser,
} from "./session";

export type AuthDeps = { db: Db; env: Env };

/** Error codes the login page knows how to explain. Never echo arbitrary input. */
export type LoginErrorCode = "access_denied" | "invalid_state" | "oauth_failed" | "rate_limited";

const AUTH_RATE_LIMIT = { limit: 30, windowSeconds: 10 * 60 };

function redirectToLogin(env: Env, code: LoginErrorCode): NextResponse {
  const url = new URL("/login", env.APP_URL);
  url.searchParams.set("error", code);
  const res = NextResponse.redirect(url, 303);
  res.headers.set("Cache-Control", "no-store");
  clearOAuthCookie(res, env);
  return res;
}

/** GET /api/auth/github — start the authorization-code + PKCE flow. */
export async function startGitHubLogin(request: NextRequest, { db, env }: AuthDeps): Promise<NextResponse> {
  const ip = clientIp(request.headers);
  const rl = await consumeRateLimit(
    db,
    `auth_start:${ip}`,
    AUTH_RATE_LIMIT.limit,
    AUTH_RATE_LIMIT.windowSeconds,
  );
  if (!rl.allowed) {
    logger.warn("auth_rate_limited", { endpoint: "start" });
    return redirectToLogin(env, "rate_limited");
  }

  const state = randomToken(32);
  const { verifier, challenge } = createPkcePair();
  const authorizeUrl = buildAuthorizeUrl({
    clientId: env.GITHUB_CLIENT_ID,
    redirectUri: callbackUrl(env.APP_URL),
    state,
    codeChallenge: challenge,
  });

  const res = NextResponse.redirect(authorizeUrl, 302);
  res.headers.set("Cache-Control", "no-store");
  setOAuthCookie(res, env, state, verifier);
  logger.info("oauth_login_started");
  return res;
}

const callbackQuerySchema = z.object({
  code: z.string().min(1).max(512).optional(),
  state: z.string().min(1).max(512).optional(),
  error: z.string().max(100).optional(),
});

/** GET /api/auth/github/callback — validate state, exchange code, create session. */
export async function handleGitHubCallback(
  request: NextRequest,
  { db, env }: AuthDeps,
): Promise<NextResponse> {
  const ip = clientIp(request.headers);
  const rl = await consumeRateLimit(
    db,
    `auth_callback:${ip}`,
    AUTH_RATE_LIMIT.limit,
    AUTH_RATE_LIMIT.windowSeconds,
  );
  if (!rl.allowed) {
    logger.warn("auth_rate_limited", { endpoint: "callback" });
    return redirectToLogin(env, "rate_limited");
  }

  const query = callbackQuerySchema.safeParse(Object.fromEntries(request.nextUrl.searchParams));
  if (!query.success) {
    logger.warn("oauth_callback_invalid_query");
    return redirectToLogin(env, "oauth_failed");
  }

  // GitHub-reported errors: user cancelled, app suspended, redirect_uri mismatch.
  if (query.data.error) {
    logger.warn("oauth_callback_github_error", { githubError: query.data.error });
    return redirectToLogin(env, query.data.error === "access_denied" ? "access_denied" : "oauth_failed");
  }

  // CSRF: the state in the URL must match the one we stored in this browser's cookie.
  const stored = parseOAuthCookie(request.cookies.get(oauthCookieName(env))?.value);
  if (!stored || !query.data.state || !safeEqual(query.data.state, stored.state)) {
    logger.warn("oauth_state_mismatch", { hadCookie: Boolean(stored), hadState: Boolean(query.data.state) });
    return redirectToLogin(env, "invalid_state");
  }
  if (!query.data.code) {
    logger.warn("oauth_callback_missing_code");
    return redirectToLogin(env, "oauth_failed");
  }

  try {
    const { user, session } = await completeGitHubLogin(db, env, {
      code: query.data.code,
      codeVerifier: stored.verifier,
    });

    // Don't leave the browser's previous session valid in the database.
    const previous = request.cookies.get(sessionCookieName(env))?.value;
    if (previous) await invalidateSession(db, previous);

    const res = NextResponse.redirect(new URL("/dashboard", env.APP_URL), 303);
    res.headers.set("Cache-Control", "no-store");
    clearOAuthCookie(res, env);
    setSessionCookie(res, env, session.token);
    logger.info("user_logged_in", { userId: user.id, githubLogin: user.githubLogin });
    return res;
  } catch (err) {
    logger.error("oauth_callback_failed", { error: serializeError(err) });
    return redirectToLogin(env, "oauth_failed");
  }
}

/** POST /api/auth/logout — delete the session server-side and clear the cookie. */
export async function handleLogout(request: NextRequest, { db, env }: AuthDeps): Promise<NextResponse> {
  if (!isSameOrigin(request.headers, env.APP_URL)) {
    logger.warn("cross_origin_request_rejected", { endpoint: "logout" });
    return jsonError(403, "forbidden", "Cross-origin request rejected.");
  }
  const token = request.cookies.get(sessionCookieName(env))?.value;
  if (token) {
    try {
      await invalidateSession(db, token);
    } catch (err) {
      logger.error("logout_session_delete_failed", { error: serializeError(err) });
      return jsonError(500, "internal_error", "Could not sign out. Please try again.");
    }
  }
  const res = NextResponse.redirect(new URL("/login", env.APP_URL), 303);
  res.headers.set("Cache-Control", "no-store");
  clearSessionCookie(res, env);
  logger.info("user_logged_out");
  return res;
}

/** Resolves the session user for API route handlers (null = unauthenticated). */
export async function getRequestUser(
  request: NextRequest,
  { db, env }: AuthDeps,
): Promise<SessionUser | null> {
  const token = request.cookies.get(sessionCookieName(env))?.value;
  return token ? validateSessionToken(db, token) : null;
}

/** GET /api/auth/me */
export async function handleMe(request: NextRequest, deps: AuthDeps): Promise<NextResponse> {
  const user = await getRequestUser(request, deps);
  if (!user) return jsonError(401, "unauthenticated", "Not signed in.");
  return NextResponse.json({ user }, { headers: { "Cache-Control": "no-store" } });
}
