import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { AuthDeps } from "../auth/handlers";
import { withUser } from "../http/api";
import { AppError } from "../http/errors";
import { getEventDetail, getStats, listEvents } from "./activity";
import { retryEvent } from "./retry";

type Deps = AuthDeps | (() => AuthDeps);
const noStore = { "Cache-Control": "no-store" };

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
  before: z.iso.datetime().optional(),
  filter: z.enum(["all", "failed", "in_progress"]).optional(),
});

function parseId(id: string): string {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new AppError(404, "not_found", "Event not found.");
  return parsed.data;
}

/** GET /api/events?limit=&before=&filter= */
export function listEventsHandler(request: NextRequest, deps: Deps) {
  return withUser(request, deps, "events_list", async (user, { db }) => {
    const parsed = listQuery.safeParse(Object.fromEntries(request.nextUrl.searchParams));
    if (!parsed.success) throw new AppError(400, "invalid_input", "Invalid query parameters.");
    return NextResponse.json(await listEvents(db, user.id, parsed.data), { headers: noStore });
  });
}

/** GET /api/events/:id */
export function getEventHandler(request: NextRequest, deps: Deps, id: string) {
  return withUser(request, deps, "events_get", async (user, { db }) =>
    NextResponse.json({ event: await getEventDetail(db, user.id, parseId(id)) }, { headers: noStore }),
  );
}

/** GET /api/stats */
export function statsHandler(request: NextRequest, deps: Deps) {
  return withUser(request, deps, "stats", async (user, { db }) =>
    NextResponse.json(await getStats(db, user.id), { headers: noStore }),
  );
}

/**
 * POST /api/events/:id/retry — resets failed steps and re-queues the job, then asks the
 * caller-provided scheduler (after() in the route) to drain it right away. The cron
 * sweeper would pick it up anyway if that background run is lost.
 */
export function retryEventHandler(
  request: NextRequest,
  deps: Deps,
  id: string,
  scheduleDrain: (deps: AuthDeps) => void,
) {
  return withUser(request, deps, "events_retry", async (user, resolved) => {
    await retryEvent(resolved.db, user.id, parseId(id));
    scheduleDrain(resolved);
    return NextResponse.json({ queued: true }, { status: 202, headers: noStore });
  });
}
