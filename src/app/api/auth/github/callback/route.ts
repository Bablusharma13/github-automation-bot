import type { NextRequest } from "next/server";
import { handleGitHubCallback } from "@/server/auth/handlers";
import { appDeps } from "@/server/deps";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: NextRequest) {
  try {
    return await handleGitHubCallback(request, appDeps());
  } catch (err) {
    return toErrorResponse(err, { route: "auth_callback" });
  }
}
