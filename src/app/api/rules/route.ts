import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { createRuleHandler, listRulesHandler } from "@/server/rules/handlers";

export function GET(request: NextRequest) {
  return listRulesHandler(request, appDeps);
}

export function POST(request: NextRequest) {
  return createRuleHandler(request, appDeps);
}
