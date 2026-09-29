import type { NextRequest } from "next/server";
import { handleLogout } from "@/server/auth/handlers";
import { appDeps } from "@/server/deps";
import { toErrorResponse } from "@/server/http/errors";

export async function POST(request: NextRequest) {
  try {
    return await handleLogout(request, appDeps());
  } catch (err) {
    return toErrorResponse(err, { route: "auth_logout" });
  }
}
