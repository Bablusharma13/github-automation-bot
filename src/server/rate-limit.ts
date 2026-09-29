import "server-only";
import { sql } from "drizzle-orm";
import type { Db } from "./db";
import { rateLimits } from "./db/schema";
import { logger, serializeError } from "./logger";

export type RateLimitResult = { allowed: boolean; retryAfterSeconds: number };

/**
 * Fixed-window counter in Postgres. One atomic upsert per call, so it is correct across
 * serverless instances (an in-memory limiter would be per-instance only).
 *
 * Fails open: if the database is unreachable the request is allowed and the failure is
 * logged. The endpoints this guards cannot do anything useful without the database
 * anyway, so failing closed would only add a second error path.
 */
export async function consumeRateLimit(
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  const expired = sql`${rateLimits.windowStart} <= now() - (${windowSeconds}::int * interval '1 second')`;
  try {
    const [row] = await db
      .insert(rateLimits)
      .values({ key, windowStart: sql`now()`, count: 1 })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: {
          count: sql`CASE WHEN ${expired} THEN 1 ELSE ${rateLimits.count} + 1 END`,
          windowStart: sql`CASE WHEN ${expired} THEN now() ELSE ${rateLimits.windowStart} END`,
        },
      })
      .returning({ count: rateLimits.count, windowStart: rateLimits.windowStart });

    if (!row || row.count <= limit) return { allowed: true, retryAfterSeconds: 0 };
    const resetsAt = row.windowStart.getTime() + windowSeconds * 1000;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((resetsAt - Date.now()) / 1000)) };
  } catch (err) {
    logger.error("rate_limit_check_failed", { key: key.split(":")[0], error: serializeError(err) });
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
