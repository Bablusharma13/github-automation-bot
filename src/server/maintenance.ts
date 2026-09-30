import "server-only";
import { lt, sql } from "drizzle-orm";
import type { Db } from "./db";
import { rateLimits, sessions } from "./db/schema";

/** Housekeeping run by the cron sweeper: drop expired sessions and stale rate-limit windows. */
export async function purgeExpired(db: Db): Promise<{ sessionsDeleted: number; rateLimitsDeleted: number }> {
  const deletedSessions = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, sql`now() - interval '1 day'`))
    .returning({ id: sessions.id });
  const deletedLimits = await db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, sql`now() - interval '1 day'`))
    .returning({ key: rateLimits.key });
  return { sessionsDeleted: deletedSessions.length, rateLimitsDeleted: deletedLimits.length };
}
