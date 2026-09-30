import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import { connectRepositoryHandler, listRepositoriesHandler } from "@/server/repositories/handlers";

export function GET(request: NextRequest) {
  return listRepositoriesHandler(request, appDeps);
}

export function POST(request: NextRequest) {
  return connectRepositoryHandler(request, appDeps);
}
