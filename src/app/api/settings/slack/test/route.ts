import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { testSlackHandler } from "@/server/slack/handlers";

export function POST(request: NextRequest) {
  return testSlackHandler(request, appDeps);
}
