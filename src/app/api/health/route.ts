import { sql } from "drizzle-orm";
import { getDb } from "@/server/db";
import { logger, serializeError } from "@/server/logger";

/** Liveness + database reachability. Reveals nothing about configuration. */
export async function GET() {
  try {
    await getDb().execute(sql`select 1`);
    return Response.json({ status: "ok", database: "ok" });
  } catch (err) {
    logger.error("health_check_failed", { error: serializeError(err) });
    return Response.json({ status: "degraded", database: "unreachable" }, { status: 503 });
  }
}
