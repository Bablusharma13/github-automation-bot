import { z } from "zod";
import {
  RULE_ACTION_TYPES,
  RULE_EVENT_ACTIONS,
  RULE_EVENT_TYPES,
  RULE_KEYWORD_SCOPES,
  RULE_LIMITS,
} from "@/lib/rules-config";

/** Trim, lower-case, drop blanks and duplicates — matching is case-insensitive anyway. */
function normalizeKeywords(keywords: string[]): string[] {
  return [...new Set(keywords.map((k) => k.trim().toLowerCase()).filter(Boolean))];
}

const ruleFields = {
  name: z
    .string()
    .trim()
    .min(1, "Name is required.")
    .max(RULE_LIMITS.nameMax, `Name is at most ${RULE_LIMITS.nameMax} characters.`),
  enabled: z.boolean(),
  eventType: z.enum(RULE_EVENT_TYPES),
  eventActions: z
    .array(z.enum(RULE_EVENT_ACTIONS))
    .min(1, "Choose at least one event action.")
    .transform((a) => [...new Set(a)]),
  keywords: z
    .array(
      z.string().max(RULE_LIMITS.keywordMax, `Keywords are at most ${RULE_LIMITS.keywordMax} characters.`),
    )
    .max(RULE_LIMITS.keywordsMax, `At most ${RULE_LIMITS.keywordsMax} keywords.`)
    .transform(normalizeKeywords),
  keywordScope: z.enum(RULE_KEYWORD_SCOPES),
  actionType: z.enum(RULE_ACTION_TYPES),
  actionValue: z.string().trim().min(1, "A label name or comment text is required."),
  notifySlack: z.boolean(),
};

/** The value's limits depend on the action, so they are checked on the whole rule. */
function checkActionValue(rule: { actionType: string; actionValue: string }, ctx: z.RefinementCtx) {
  if (rule.actionType === "add_label" && rule.actionValue.length > RULE_LIMITS.labelMax) {
    ctx.addIssue({
      code: "custom",
      path: ["actionValue"],
      message: `Label names are at most ${RULE_LIMITS.labelMax} characters.`,
    });
  }
  if (rule.actionType === "add_comment" && rule.actionValue.length > RULE_LIMITS.commentMax) {
    ctx.addIssue({
      code: "custom",
      path: ["actionValue"],
      message: `Comments are at most ${RULE_LIMITS.commentMax} characters.`,
    });
  }
}

/** A complete rule (used for creation and to re-validate a rule after a PATCH is merged in). */
export const ruleSchema = z.strictObject(ruleFields).superRefine(checkActionValue);

export const createRuleSchema = z
  .strictObject({
    repositoryId: z.uuid("Choose a connected repository."),
    name: ruleFields.name,
    enabled: ruleFields.enabled.default(true),
    eventType: ruleFields.eventType,
    eventActions: ruleFields.eventActions.default(["opened"]),
    keywords: ruleFields.keywords.default([]),
    keywordScope: ruleFields.keywordScope.default("title"),
    actionType: ruleFields.actionType,
    actionValue: ruleFields.actionValue,
    notifySlack: ruleFields.notifySlack.default(true),
  })
  .superRefine(checkActionValue);

/**
 * A PATCH may change any subset of fields (not the repository). Unknown keys are
 * rejected so a typo cannot silently do nothing.
 */
export const updateRuleSchema = z
  .strictObject({
    name: ruleFields.name,
    enabled: ruleFields.enabled,
    eventType: ruleFields.eventType,
    eventActions: z.array(z.enum(RULE_EVENT_ACTIONS)),
    keywords: z.array(z.string()),
    keywordScope: ruleFields.keywordScope,
    actionType: ruleFields.actionType,
    actionValue: z.string(),
    notifySlack: ruleFields.notifySlack,
  })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, "Nothing to update.");

export type CreateRuleInput = z.infer<typeof createRuleSchema>;
export type UpdateRuleInput = z.infer<typeof updateRuleSchema>;
