import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { listEventsHandler } from "@/server/events/handlers";

export function GET(request: NextRequest) {
  return listEventsHandler(request, appDeps);
}
