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
 * Code → token → GitHub profile → local user (created or updated) → new session.
 * The access token is encrypted before it touches the database and is never returned.
 */
export async function completeGitHubLogin(
  db: Db,
  env: Env,
  input: { code: string; codeVerifier: string },
): Promise<{ user: SessionUser; session: { token: string; expiresAt: Date } }> {
  const { accessToken, scopes } = await exchangeCodeForToken({
    clientId: env.GITHUB_CLIENT_ID,
    clientSecret: env.GITHUB_CLIENT_SECRET,
    code: input.code,
    codeVerifier: input.codeVerifier,
    redirectUri: callbackUrl(env.APP_URL),
  });

  const profile = await getAuthenticatedUser(accessToken);

  let email = profile.email;
  if (!email && scopes.includes("user:email")) {
    try {
      email = await getPrimaryVerifiedEmail(accessToken);
    } catch (err) {
      // Email is display-only; sign-in proceeds without it.
      logger.warn("github_email_lookup_failed", { githubLogin: profile.login, error: serializeError(err) });
    }
  }

  const values = {
    githubUserId: profile.id,
    githubLogin: profile.login,
    name: profile.name,
    email,
    avatarUrl: profile.avatar_url,
    accessTokenEnc: encryptSecret(accessToken, env.TOKEN_ENCRYPTION_KEY),
    tokenScopes: scopes.join(","),
  };

  const [user] = await db
    .insert(users)
    .values(values)
    .onConflictDoUpdate({
      target: users.githubUserId,
      set: {
        githubLogin: values.githubLogin,
        name: values.name,
        email: values.email,
        avatarUrl: values.avatarUrl,
        accessTokenEnc: values.accessTokenEnc,
        tokenScopes: values.tokenScopes,
        updatedAt: new Date(),
      },
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
  return { user, session };
}
