import "server-only";
import { and, asc, eq } from "drizzle-orm";
import type { RuleDTO } from "@/lib/rules-config";
import type { Db } from "../db";
import { repositories, rules, type Rule } from "../db/schema";
import { AppError } from "../http/errors";
import { logger } from "../logger";
import { ruleSchema, type CreateRuleInput, type UpdateRuleInput } from "./validation";

function toDTO(rule: Rule, repo: { fullName: string; active: boolean }): RuleDTO {
  return {
    id: rule.id,
    repositoryId: rule.repositoryId,
    repositoryFullName: repo.fullName,
    repositoryActive: repo.active,
    name: rule.name,
    enabled: rule.enabled,
    eventType: rule.eventType,
    eventActions: rule.eventActions as RuleDTO["eventActions"],
    keywords: rule.keywords,
    keywordScope: rule.keywordScope,
    actionType: rule.actionType,
    actionValue: rule.actionValue,
    notifySlack: rule.notifySlack,
    aiTriage: rule.aiTriage,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: rule.updatedAt.toISOString(),
  };
}

const notFound = () => new AppError(404, "not_found", "Rule not found.");

/** The caller's rules (optionally for one repository). Always scoped by user id. */
export async function listRules(db: Db, userId: string, repositoryId?: string): Promise<RuleDTO[]> {
  const rows = await db
    .select({ rule: rules, repo: { fullName: repositories.fullName, active: repositories.active } })
    .from(rules)
    .innerJoin(repositories, eq(rules.repositoryId, repositories.id))
    .where(
      and(
        eq(rules.userId, userId),
        eq(repositories.userId, userId),
        repositoryId ? eq(rules.repositoryId, repositoryId) : undefined,
      ),
    )
    .orderBy(asc(repositories.fullName), asc(rules.createdAt));
  return rows.map(({ rule, repo }) => toDTO(rule, repo));
}

async function loadOwnRule(db: Db, userId: string, id: string) {
  const [row] = await db
    .select({ rule: rules, repo: { fullName: repositories.fullName, active: repositories.active } })
    .from(rules)
    .innerJoin(repositories, eq(rules.repositoryId, repositories.id))
    .where(and(eq(rules.id, id), eq(rules.userId, userId)))
    .limit(1);
  // Another user's rule is indistinguishable from a missing one.
  if (!row) throw notFound();
  return row;
}

export async function getRule(db: Db, userId: string, id: string): Promise<RuleDTO> {
  const { rule, repo } = await loadOwnRule(db, userId, id);
  return toDTO(rule, repo);
}

export async function createRule(db: Db, userId: string, input: CreateRuleInput): Promise<RuleDTO> {
  // The repository id comes from the client: it must be one of the caller's connected repos.
  const [repo] = await db
    .select({ id: repositories.id, fullName: repositories.fullName, active: repositories.active })
    .from(repositories)
    .where(
      and(
        eq(repositories.id, input.repositoryId),
        eq(repositories.userId, userId),
        eq(repositories.active, true),
      ),
    )
    .limit(1);
  if (!repo) throw new AppError(404, "repository_not_found", "Connected repository not found.");

  const [rule] = await db
    .insert(rules)
    .values({ ...input, userId })
    .returning();
  logger.info("rule_created", { userId, ruleId: rule!.id, repository: repo.fullName });
  return toDTO(rule!, repo);
}

/**
 * Applies a partial update. The merged rule is validated as a whole, so e.g. switching
 * to add_label with a 2,000-character value, or removing every event action, is rejected.
 */
export async function updateRule(
  db: Db,
  userId: string,
  id: string,
  patch: UpdateRuleInput,
): Promise<RuleDTO> {
  const { rule, repo } = await loadOwnRule(db, userId, id);
  const merged = ruleSchema.safeParse({
    name: patch.name ?? rule.name,
    enabled: patch.enabled ?? rule.enabled,
    eventType: patch.eventType ?? rule.eventType,
    eventActions: patch.eventActions ?? rule.eventActions,
    keywords: patch.keywords ?? rule.keywords,
    keywordScope: patch.keywordScope ?? rule.keywordScope,
    actionType: patch.actionType ?? rule.actionType,
    actionValue: patch.actionValue ?? rule.actionValue,
    notifySlack: patch.notifySlack ?? rule.notifySlack,
    aiTriage: patch.aiTriage ?? rule.aiTriage,
  });
  if (!merged.success) {
    const issue = merged.error.issues[0];
    throw new AppError(400, "invalid_input", issue?.message ?? "Invalid rule.");
  }
  const [updated] = await db
    .update(rules)
    .set({ ...merged.data, updatedAt: new Date() })
    .where(and(eq(rules.id, id), eq(rules.userId, userId)))
    .returning();
  if (!updated) throw notFound();
  logger.info("rule_updated", { userId, ruleId: id, fields: Object.keys(patch) });
  return toDTO(updated, repo);
}

/** Deletes the rule. Past automation runs keep their snapshot of it (rule_id → null). */
export async function deleteRule(db: Db, userId: string, id: string): Promise<void> {
  const deleted = await db
    .delete(rules)
    .where(and(eq(rules.id, id), eq(rules.userId, userId)))
    .returning({ id: rules.id });
  if (deleted.length === 0) throw notFound();
  logger.info("rule_deleted", { userId, ruleId: id });
}
