import "server-only";
import { eq } from "drizzle-orm";
import { decryptSecret, encryptSecret } from "../crypto";
import type { Db } from "../db";
import { users } from "../db/schema";
import type { Env } from "../env";
import { logger, serializeError } from "../logger";
import { OAuthError, refreshAccessToken } from "./oauth";

/** Refresh this long before expiry so a token never expires mid-request. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

/**
 * The user's GitHub authorization is no longer usable (revoked, or the refresh token
 * expired). Not retryable: only the user signing in again fixes it.
 */
export class GitHubReauthRequiredError extends Error {
  readonly retryable = false;
  constructor(message = "GitHub authorization expired or was revoked. Sign in again to resume automation.") {
    super(message);
    this.name = "GitHubReauthRequiredError";
  }
}

type TokenRow = Pick<
  typeof users.$inferSelect,
  | "accessTokenEnc"
  | "accessTokenExpiresAt"
  | "refreshTokenEnc"
  | "refreshTokenExpiresAt"
  | "githubReauthRequiredAt"
>;

const tokenColumns = {
  accessTokenEnc: users.accessTokenEnc,
  accessTokenExpiresAt: users.accessTokenExpiresAt,
  refreshTokenEnc: users.refreshTokenEnc,
  refreshTokenExpiresAt: users.refreshTokenExpiresAt,
  githubReauthRequiredAt: users.githubReauthRequiredAt,
};

function isFresh(row: TokenRow, now: number): boolean {
  return row.accessTokenExpiresAt === null || row.accessTokenExpiresAt.getTime() - REFRESH_MARGIN_MS > now;
}

export async function markGitHubReauthRequired(db: Db, userId: string, reason: string): Promise<void> {
  await db.update(users).set({ githubReauthRequiredAt: new Date() }).where(eq(users.id, userId));
  logger.warn("github_reauth_required", { userId, reason });
}

/**
 * Returns a usable GitHub access token for background work, refreshing it when it is
 * about to expire.
 *
 * GitHub rotates refresh tokens: once one is used, it and the old access token stop
 * working. Two workers refreshing concurrently would therefore break the user's
 * authorization, so the refresh happens under a row lock (`SELECT ... FOR UPDATE`) and
 * the expiry is re-checked after acquiring it — the second worker simply reuses the
 * token the first one stored.
 */
export async function getUserAccessToken(db: Db, env: Env, userId: string): Promise<string> {
  const key = env.TOKEN_ENCRYPTION_KEY;
  const [row] = await db.select(tokenColumns).from(users).where(eq(users.id, userId)).limit(1);
  if (!row) throw new Error(`User ${userId} not found`);
  if (row.githubReauthRequiredAt) throw new GitHubReauthRequiredError();
  if (isFresh(row, Date.now())) return decryptSecret(row.accessTokenEnc, key);

  type Outcome = { token: string } | { reauth: string };
  const outcome: Outcome = await db.transaction(async (tx) => {
    const [locked] = await tx
      .select(tokenColumns)
      .from(users)
      .where(eq(users.id, userId))
      .for("update")
      .limit(1);
    if (!locked) throw new Error(`User ${userId} not found`);
    if (locked.githubReauthRequiredAt) return { reauth: "already_flagged" };
    // Another worker refreshed while we waited for the lock.
    if (isFresh(locked, Date.now())) return { token: decryptSecret(locked.accessTokenEnc, key) };

    if (!locked.refreshTokenEnc) return { reauth: "access_token_expired_without_refresh_token" };
    if (locked.refreshTokenExpiresAt && locked.refreshTokenExpiresAt.getTime() <= Date.now()) {
      return { reauth: "refresh_token_expired" };
    }

    let tokens;
    try {
      tokens = await refreshAccessToken({
        clientId: env.GITHUB_CLIENT_ID,
        clientSecret: env.GITHUB_CLIENT_SECRET,
        refreshToken: decryptSecret(locked.refreshTokenEnc, key),
      });
    } catch (err) {
      if (err instanceof OAuthError && err.code === "bad_refresh_token")
        return { reauth: "bad_refresh_token" };
      // Transient failures (network, GitHub 5xx) and config errors propagate; the stored
      // tokens are untouched so a later retry can still succeed.
      throw err;
    }

    await tx
      .update(users)
      .set({
        accessTokenEnc: encryptSecret(tokens.accessToken, key),
        accessTokenExpiresAt: tokens.accessTokenExpiresAt,
        // Keep the old refresh token only if GitHub did not send a new one.
        ...(tokens.refreshToken
          ? {
              refreshTokenEnc: encryptSecret(tokens.refreshToken, key),
              refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(users.id, userId));
    logger.info("github_token_refreshed", { userId, expiresAt: tokens.accessTokenExpiresAt?.toISOString() });
    return { token: tokens.accessToken };
  });

  if ("token" in outcome) return outcome.token;
  // Flag outside the transaction so the flag survives even though no token was produced.
  if (outcome.reauth !== "already_flagged") {
    try {
      await markGitHubReauthRequired(db, userId, outcome.reauth);
    } catch (err) {
      logger.error("github_reauth_flag_failed", { userId, error: serializeError(err) });
    }
  }
  throw new GitHubReauthRequiredError();
}
