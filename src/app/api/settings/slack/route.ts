import type { NextRequest } from "next/server";
import { appDeps } from "@/server/deps";
import {
  clearSlackSettingsHandler,
  getSlackSettingsHandler,
  saveSlackSettingsHandler,
} from "@/server/slack/handlers";

export function GET(request: NextRequest) {
  return getSlackSettingsHandler(request, appDeps);
}

export function PUT(request: NextRequest) {
  return saveSlackSettingsHandler(request, appDeps);
}

export function DELETE(request: NextRequest) {
  return clearSlackSettingsHandler(request, appDeps);
}
