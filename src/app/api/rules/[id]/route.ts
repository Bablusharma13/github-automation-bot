import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { deleteRuleHandler, getRuleHandler, updateRuleHandler } from "@/server/rules/handlers";

export async function GET(request: NextRequest, ctx: RouteContext<"/api/rules/[id]">) {
  return getRuleHandler(request, appDeps, (await ctx.params).id);
}

export async function PATCH(request: NextRequest, ctx: RouteContext<"/api/rules/[id]">) {
  return updateRuleHandler(request, appDeps, (await ctx.params).id);
}

export async function DELETE(request: NextRequest, ctx: RouteContext<"/api/rules/[id]">) {
  return deleteRuleHandler(request, appDeps, (await ctx.params).id);
}
