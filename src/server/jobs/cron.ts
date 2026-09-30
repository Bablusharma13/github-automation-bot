import "server-only";
import type { NextRequest } from "next/server";
import { safeEqual } from "../crypto";
import type { Db } from "../db";
import type { Env } from "../env";
import { logger, serializeError } from "../logger";
import { purgeExpired } from "../maintenance";
import { drainJobs, type DrainOptions } from "./worker";

const noStore = { "Cache-Control": "no-store" };

/**
 * GET /api/cron/worker — the sweeper. Called by Vercel Cron (daily on Hobby) and by a
 * GitHub Actions schedule (~every 5 min), both with `Authorization: Bearer $CRON_SECRET`.
 * Picks up retries whose backoff has elapsed and jobs whose worker died.
 * The response only contains counts (it ends up in public workflow logs).
 */
export async function handleCronWorker(
  request: NextRequest,
  deps: { db: Db; env: Env },
  drainOptions: Partial<DrainOptions> = {},
): Promise<Response> {
  const auth = request.headers.get("authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${deps.env.CRON_SECRET}`)) {
    logger.warn("cron_unauthorized");
    return Response.json(
      { error: { code: "unauthorized", message: "Unauthorized." } },
      { status: 401, headers: noStore },
    );
  }
  try {
    const stats = await drainJobs(deps.db, deps.env, { budgetMs: 50_000, ...drainOptions });
    const cleaned = await purgeExpired(deps.db);
    logger.info("cron_worker_completed", { ...stats, ...cleaned });
    return Response.json({ ok: true, ...stats, ...cleaned }, { headers: noStore });
  } catch (err) {
    logger.error("cron_worker_failed", { error: serializeError(err) });
    return Response.json(
      { error: { code: "internal_error", message: "Sweep failed." } },
      { status: 500, headers: noStore },
    );
  }
}
