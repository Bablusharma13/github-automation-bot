import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { listConnectableHandler } from "@/server/repositories/handlers";

export function GET(request: NextRequest) {
  return listConnectableHandler(request, appDeps);
}
