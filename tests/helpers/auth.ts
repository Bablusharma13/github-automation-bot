import { NextRequest } from "next/server";
import { createSession, sessionCookieName } from "@/server/auth/session";
import { encryptSecret } from "@/server/crypto";
import type { Db } from "@/server/db";
import { users } from "@/server/db/schema";
import type { Env } from "@/server/env";

let nextGithubId = 900_000;

/** Creates a user with a (fake, encrypted) non-expiring GitHub token and a live session. */
export async function createSignedInUser(
  db: Db,
  env: Env,
  login: string,
  githubToken = `gho_${login}_token`,
) {
  const [user] = await db
    .insert(users)
    .values({
      githubUserId: ++nextGithubId,
      githubLogin: login,
      accessTokenEnc: encryptSecret(githubToken, env.TOKEN_ENCRYPTION_KEY),
      tokenScopes: "public_repo,read:user,user:email",
    })
    .returning();
  const session = await createSession(db, user!.id);
  return { user: user!, githubToken, cookie: `${sessionCookieName(env)}=${session.token}` };
}

/** Builds an API request as the browser would send it (same-origin for mutations). */
export function apiRequest(
  env: Env,
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; origin?: string | null } = {},
) {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null && method !== "GET") headers.origin = opts.origin ?? env.APP_URL;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  return new NextRequest(`${env.APP_URL}${path}`, {
    method,
    headers,
    body:
      opts.body === undefined
        ? undefined
        : typeof opts.body === "string"
          ? opts.body
          : JSON.stringify(opts.body),
  });
}
