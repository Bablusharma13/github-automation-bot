import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { handleCronWorker } from "@/server/jobs/cron";
import { logger, serializeError } from "@/server/logger";

// Leaves headroom above the 50s drain budget. Vercel Hobby allows up to 300s.
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  let deps;
  try {
    deps = appDeps();
  } catch (err) {
    logger.error("cron_worker_config_invalid", { error: serializeError(err) });
    return Response.json(
      { error: { code: "internal_error", message: "Server misconfigured." } },
      { status: 500 },
    );
  }
  return handleCronWorker(request, deps);
}
