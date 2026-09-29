import "server-only";
import { encryptSecret } from "../crypto";
import type { Db } from "../db";
import { users } from "../db/schema";
import type { Env } from "../env";
import {
  callbackUrl,
  exchangeCodeForToken,
  getAuthenticatedUser,
  getPrimaryVerifiedEmail,
} from "../github/oauth";
import { logger, serializeError } from "../logger";
import { createSession, type SessionUser } from "./session";

/**
 * Code → tokens → GitHub profile → local user (created or updated) → new session.
 * Tokens are encrypted before they touch the database and are never returned.
 */
export async function completeGitHubLogin(
  db: Db,
  env: Env,
  input: { code: string; codeVerifier: string },
): Promise<{ user: SessionUser; session: { token: string; expiresAt: Date } }> {
  const tokens = await exchangeCodeForToken({
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    code: input.code,
    codeVerifier: input.codeVerifier,
    redirectUri: callbackUrl(env.APP_URL),
  });

  const profile = await getAuthenticatedUser(tokens.accessToken);

  let email = profile.email;
  if (!email && tokens.scopes.includes("user:email")) {
    try {
      email = await getPrimaryVerifiedEmail(tokens.accessToken);
    } catch (err) {
      // Email is display-only; sign-in proceeds without it.
      logger.warn("github_email_lookup_failed", { githubLogin: profile.login, error: serializeError(err) });
    }
  }

  const key = env.TOKEN_ENCRYPTION_KEY;
  const credentials = {
    accessTokenEnc: encryptSecret(tokens.accessToken, key),
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenEnc: tokens.refreshToken ? encryptSecret(tokens.refreshToken, key) : null,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
    tokenScopes: tokens.scopes.join(","),
    // A fresh sign-in always yields working credentials.
    githubReauthRequiredAt: null,
  };
  const profileFields = {
    githubLogin: profile.login,
    name: profile.name,
    email,
    avatarUrl: profile.avatar_url,
  };

  const [user] = await db
    .insert(users)
    .values({ githubUserId: profile.id, ...profileFields, ...credentials })
    .onConflictDoUpdate({
      target: users.githubUserId,
      set: { ...profileFields, ...credentials, updatedAt: new Date() },
    })
    .returning({
      id: users.id,
      githubLogin: users.githubLogin,
      name: users.name,
      email: users.email,
      avatarUrl: users.avatarUrl,
    });
  if (!user) throw new Error("User upsert returned no row");

  const session = await createSession(db, user.id);
  logger.info("github_tokens_stored", {
    userId: user.id,
    expiring: tokens.accessTokenExpiresAt !== null,
    hasRefreshToken: tokens.refreshToken !== null,
  });
  return { user, session };
}
