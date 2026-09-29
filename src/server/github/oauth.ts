import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { randomToken } from "../crypto";
import { githubRequest, USER_AGENT } from "./api";

/**
 * Least privilege for the core flow: read the profile/email, and create repository
 * webhooks + write labels/comments on PUBLIC repositories. Private repos would require
 * the much broader `repo` scope (see docs/ARCHITECTURE.md).
 */
export const OAUTH_SCOPES = ["read:user", "user:email", "public_repo"] as const;

const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";

export class OAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** Transient (network, GitHub 5xx) vs. permanent (rejected code/refresh token, bad config). */
    readonly retryable = false,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "OAuthError";
  }
}

export function callbackUrl(appUrl: string): string {
  return `${appUrl}/api/auth/github/callback`;
}

/** PKCE (RFC 7636, S256 — the only method GitHub accepts). */
export function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomToken(32); // 43 base64url chars, within the 43–128 limit
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildAuthorizeUrl(params: {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", params.clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", OAUTH_SCOPES.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string(),
  scope: z.string().default(""),
  // Present only when the app has "Expire user access tokens" enabled (GitHub's default
  // for new OAuth apps): access token 8h, refresh token 6 months.
  expires_in: z.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  refresh_token_expires_in: z.number().int().positive().optional(),
});

export type TokenSet = {
  accessToken: string;
  /** Empty on refresh responses; callers keep the previously granted scopes. */
  scopes: string[];
  accessTokenExpiresAt: Date | null;
  refreshToken: string | null;
  refreshTokenExpiresAt: Date | null;
};

/**
 * POSTs to GitHub's token endpoint (used for both code exchange and refresh). GitHub
 * reports failures such as `bad_verification_code` / `bad_refresh_token` in the JSON
 * body, so the body is always validated rather than trusting the HTTP status.
 */
async function requestToken(form: Record<string, string>, purpose: string): Promise<TokenSet> {
  const requestedAt = Date.now();
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams(form),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (err) {
    throw new OAuthError("network_error", `Could not reach GitHub for ${purpose}`, true, { cause: err });
  }

  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    // Error codes/descriptions are GitHub's public documentation strings, safe to log.
    const description =
      "error_description" in body && typeof body.error_description === "string" ? body.error_description : "";
    throw new OAuthError(body.error, `GitHub rejected ${purpose}: ${body.error} ${description}`.trim());
  }
  if (!res.ok) {
    throw new OAuthError("http_error", `GitHub ${purpose} failed with HTTP ${res.status}`, res.status >= 500);
  }

  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new OAuthError("invalid_response", `GitHub ${purpose} returned an unexpected response`);
  }
  const t = parsed.data;
  // Measure expiry from when we sent the request, so clock drift errs on the early side.
  const at = (seconds: number | undefined) => (seconds ? new Date(requestedAt + seconds * 1000) : null);
  return {
    accessToken: t.access_token,
    scopes: t.scope.split(/[,\s]+/).filter(Boolean),
    accessTokenExpiresAt: at(t.expires_in),
    refreshToken: t.refresh_token ?? null,
    refreshTokenExpiresAt: at(t.refresh_token_expires_in),
  };
}

export function exchangeCodeForToken(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenSet> {
  return requestToken(
    {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    },
    "the authorization code exchange",
  );
}

/** Rotates tokens: after this call the old refresh token AND old access token stop working. */
export function refreshAccessToken(params: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<TokenSet> {
  return requestToken(
    {
      client_id: params.clientId,
      client_secret: params.clientSecret,
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    },
    "the token refresh",
  );
}

const githubUserSchema = z.object({
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatar_url: z.url(),
});
export type GitHubUser = z.infer<typeof githubUserSchema>;

export async function getAuthenticatedUser(token: string): Promise<GitHubUser> {
  const data = await githubRequest(token, "GET", "/user");
  const parsed = githubUserSchema.safeParse(data);
  if (!parsed.success) throw new OAuthError("invalid_response", "GitHub /user returned an unexpected shape");
  return parsed.data;
}

const emailsSchema = z.array(z.object({ email: z.string(), primary: z.boolean(), verified: z.boolean() }));

/** `/user` only returns a *public* email; the primary verified one needs `user:email`. */
export async function getPrimaryVerifiedEmail(token: string): Promise<string | null> {
  const parsed = emailsSchema.safeParse(await githubRequest(token, "GET", "/user/emails"));
  if (!parsed.success) return null;
  return parsed.data.find((e) => e.primary && e.verified)?.email ?? null;
}
