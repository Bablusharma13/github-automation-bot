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
});

/**
 * Exchanges the authorization code. GitHub reports failures such as
 * `bad_verification_code` in the JSON body, so the body is always validated rather than
 * trusting the HTTP status.
 */
export async function exchangeCodeForToken(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<{ accessToken: string; scopes: string[] }> {
  let res: Response;
  try {
    res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": USER_AGENT,
      },
      body: new URLSearchParams({
        client_id: params.clientId,
        client_secret: params.clientSecret,
        code: params.code,
        redirect_uri: params.redirectUri,
        code_verifier: params.codeVerifier,
      }),
      signal: AbortSignal.timeout(10_000),
      cache: "no-store",
    });
  } catch (err) {
    throw new OAuthError("network_error", "Could not reach GitHub to exchange the authorization code", {
      cause: err,
    });
  }

  const body: unknown = await res.json().catch(() => null);
  if (body && typeof body === "object" && "error" in body && typeof body.error === "string") {
    // Error codes/descriptions are GitHub's public documentation strings, safe to log.
    const description =
      "error_description" in body && typeof body.error_description === "string" ? body.error_description : "";
    throw new OAuthError(body.error, `Token exchange rejected: ${body.error} ${description}`.trim());
  }
  if (!res.ok) throw new OAuthError("http_error", `Token exchange failed with HTTP ${res.status}`);

  const parsed = tokenResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.token_type.toLowerCase() !== "bearer") {
    throw new OAuthError("invalid_response", "Token exchange returned an unexpected response");
  }
  return {
    accessToken: parsed.data.access_token,
    scopes: parsed.data.scope.split(/[,\s]+/).filter(Boolean),
  };
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
