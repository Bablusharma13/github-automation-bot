import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { getDb } from "../db";
import { getEnv } from "../env";
import { sessionCookieName, validateSessionToken, type SessionUser } from "./session";

/**
 * Session lookup for Server Components, memoised per render pass. Checks happen in
 * pages (and API routes), not layouts — layouts don't re-run on client navigation.
 */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  // Read cookies BEFORE touching env/db: `cookies()` is what marks the route as dynamic.
  // Calling getEnv() first made `next build` try to prerender these pages and fail
  // whenever server secrets were not present at build time.
  const cookieStore = await cookies();
  const env = getEnv();
  const token = cookieStore.get(sessionCookieName(env))?.value;
  if (!token) return null;
  return validateSessionToken(getDb(), token);
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
