import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { getEventHandler } from "@/server/events/handlers";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/events/[id]">) {
  return getEventHandler(request, appDeps, (await ctx.params).id);
}
