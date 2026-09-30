import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { AuthDeps } from "../auth/handlers";
import { parseJsonBody, withUser } from "../http/api";
import { AppError } from "../http/errors";
import { createRule, deleteRule, getRule, listRules, updateRule } from "./service";
import { createRuleSchema, updateRuleSchema } from "./validation";

type Deps = AuthDeps | (() => AuthDeps);
const noStore = { "Cache-Control": "no-store" };

function parseId(id: string): string {
  const parsed = z.uuid().safeParse(id);
  if (!parsed.success) throw new AppError(404, "not_found", "Rule not found.");
  return parsed.data;
}

/** GET /api/rules[?repositoryId=] */
export function listRulesHandler(request: NextRequest, deps: Deps) {
  return withUser(request, deps, "rules_list", async (user, { db }) => {
    const repositoryId = request.nextUrl.searchParams.get("repositoryId");
    if (repositoryId !== null && !z.uuid().safeParse(repositoryId).success) {
      throw new AppError(400, "invalid_input", "repositoryId must be a UUID.");
    }
    return NextResponse.json(
      { rules: await listRules(db, user.id, repositoryId ?? undefined) },
      { headers: noStore },
    );
  });
}

/** POST /api/rules */
export function createRuleHandler(request: NextRequest, deps: Deps) {
  return withUser(request, deps, "rules_create", async (user, { db }) => {
    const input = await parseJsonBody(request, createRuleSchema);
    return NextResponse.json(
      { rule: await createRule(db, user.id, input) },
      { status: 201, headers: noStore },
    );
  });
}

/** GET /api/rules/:id */
export function getRuleHandler(request: NextRequest, deps: Deps, id: string) {
  return withUser(request, deps, "rules_get", async (user, { db }) =>
    NextResponse.json({ rule: await getRule(db, user.id, parseId(id)) }, { headers: noStore }),
  );
}

/** PATCH /api/rules/:id */
export function updateRuleHandler(request: NextRequest, deps: Deps, id: string) {
  return withUser(request, deps, "rules_update", async (user, { db }) => {
    const ruleId = parseId(id);
    const patch = await parseJsonBody(request, updateRuleSchema);
    return NextResponse.json({ rule: await updateRule(db, user.id, ruleId, patch) }, { headers: noStore });
  });
}

/** DELETE /api/rules/:id */
export function deleteRuleHandler(request: NextRequest, deps: Deps, id: string) {
  return withUser(request, deps, "rules_delete", async (user, { db }) => {
    await deleteRule(db, user.id, parseId(id));
    return NextResponse.json({ deleted: true }, { headers: noStore });
  });
}
