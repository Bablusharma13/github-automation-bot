import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { statsHandler } from "@/server/events/handlers";

export function GET(request: NextRequest) {
  return statsHandler(request, appDeps);
}
