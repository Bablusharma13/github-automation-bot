import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { disconnectRepositoryHandler, getRepositoryHandler } from "@/server/repositories/handlers";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/repositories/[id]">) {
  const { id } = await ctx.params;
  return getRepositoryHandler(request, appDeps, id);
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/repositories/[id]">) {
  const { id } = await ctx.params;
  return disconnectRepositoryHandler(request, appDeps, id);
}
