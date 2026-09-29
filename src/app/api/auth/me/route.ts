import type { NextRequest } from "next/server";
import { handleMe } from "@/server/auth/handlers";
import { appDeps } from "@/server/deps";
import { toErrorResponse } from "@/server/http/errors";

export async function GET(request: NextRequest) {
  try {
    return await handleMe(request, appDeps());
  } catch (err) {
    return toErrorResponse(err, { route: "auth_me" });
  }
}
