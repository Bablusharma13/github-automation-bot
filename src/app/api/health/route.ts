import { sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { getEnv } from "@/server/env";
import { logger, serializeError } from "@/server/logger";

/**
 * Liveness + configuration + database reachability. Configuration problems are reported
 * separately from database problems (a missing env var used to show up as "database
 * unreachable"), but only as "invalid" — which variables are wrong goes to server logs.
 */
export async function GET() {
  try {
    getEnv();
  } catch (err) {
    logger.error("health_check_config_invalid", { error: serializeError(err) });
    return Response.json(
      { status: "degraded", config: "invalid", database: "unknown" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  try {
    await getDb().execute(sql`select 1`);
    return Response.json(
      { status: "ok", config: "ok", database: "ok" },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    logger.error("health_check_failed", { error: serializeError(err) });
    return Response.json(
      { status: "degraded", config: "ok", database: "unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
