import "server-only";
import { attachDatabasePool } from "@vercel/functions";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { Pool } from "pg";
import { getEnv } from "../env";
import { logger, serializeError } from "../logger";
import * as schema from "./schema";

/**
 * Driver-agnostic database handle. Production uses node-postgres against Neon; tests use
 * PGlite. Transactions (`PgTransaction`) are also assignable to this type, so services
 * accept `Db` and work inside or outside a transaction.
 */
export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;

// Reuse one pool per server instance (and across hot reloads in dev).
const globalForDb = globalThis as unknown as { __automationBotDb?: Db };

export function getDb(): Db {
  if (!globalForDb.__automationBotDb) {
    const pool = new Pool({
      connectionString: getEnv().DATABASE_URL,
      max: 5,
      // Short idle timeout: on Vercel, attachDatabasePool keeps the invocation alive
      // until idle clients are released, so this bounds how long that takes.
      idleTimeoutMillis: 5_000,
      connectionTimeoutMillis: 5_000,
    });
    pool.on("error", (err) => logger.error("db_pool_error", { error: serializeError(err) }));
    // Vercel Fluid compute: release idle connections before the instance suspends instead
    // of leaking them. No-op outside Vercel (it checks VERCEL_URL / VERCEL_REGION).
    attachDatabasePool(pool);
    globalForDb.__automationBotDb = drizzle({ client: pool, schema });
  }
  return globalForDb.__automationBotDb;
}

export { schema };
