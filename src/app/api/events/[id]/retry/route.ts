import { after, type NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { retryEventHandler } from "@/server/events/handlers";
import { drainJobs } from "@/server/jobs/worker";
import { logger, serializeError } from "@/server/logger";

export const maxDuration = 60;

export async function POST(request: NextRequest, ctx: RouteContext<"/api/events/[id]/retry">) {
  return retryEventHandler(request, appDeps, (await ctx.params).id, ({ db, env }) =>
    after(async () => {
      try {
        const stats = await drainJobs(db, env, { budgetMs: 50_000, waitForRetries: true });
        logger.info("drain_after_retry_completed", stats);
      } catch (err) {
        logger.error("drain_after_retry_failed", { error: serializeError(err) });
      }
    }),
  );
}
