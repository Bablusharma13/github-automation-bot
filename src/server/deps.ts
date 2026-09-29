import "server-only";
import { getDb } from "./db";
import { getEnv } from "./env";

/** Production dependencies for route handlers. Tests pass their own (PGlite, fake env). */
export function appDeps() {
  return { db: getDb(), env: getEnv() };
}
