import "server-only";
import { eq } from "drizzle-orm";
import { users, type GitHubStepResult } from "../db/schema";
import { GitHubApiError, githubRequest } from "../github/api";
import { getUserAccessToken, markGitHubReauthRequired } from "../github/user-token";
import { StepError } from "./errors";
import type { StepContext } from "./executors";

const MAX_LABEL_PAGES = 5;
const MAX_COMMENT_PAGES = 5;
/** Look this far before the run was created, to tolerate clock skew with GitHub. */
const COMMENT_LOOKBACK_MS = 10 * 60 * 1000;

type Label = { name: string };
type Comment = { id: number; html_url: string; body?: string | null; user?: { login: string } | null };

/** Hidden in rendered markdown; identifies the comment a run posted, so retries never post twice. */
export function commentMarker(runId: string): string {
  return `<!-- github-automation-bot:run:${runId} -->`;
}

export function commentBody(text: string, ruleName: string, runId: string): string {
  const safeRuleName = ruleName.replace(/[<>`*_[\]]/g, "");
  return `${text}\n\n<sub>Posted automatically by Automation Bot · rule “${safeRuleName}”</sub>\n${commentMarker(runId)}`;
}

function repoPath(ctx: StepContext) {
  return `/repos/${encodeURIComponent(ctx.repository.owner)}/${encodeURIComponent(ctx.repository.name)}`;
}

async function listAll<T>(token: string, path: string, maxPages: number): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const batch = await githubRequest<T[]>(token, "GET", `${path}${sep}per_page=100&page=${page}`);
    items.push(...batch);
    if (batch.length < 100) break;
  }
  return items;
}

/**
 * Turns GitHub failures into messages a user can act on. Permanent problems are marked
 * non-retryable; transient ones (5xx, network, rate limits) keep GitHubApiError's flag.
 */
async function explain(err: unknown, ctx: StepContext): Promise<never> {
  if (!(err instanceof GitHubApiError)) throw err;
  const item = `${ctx.subject.kind === "pull_request" ? "Pull request" : "Issue"} #${ctx.subject.number}`;
  if (err.status === 401) {
    await markGitHubReauthRequired(ctx.db, ctx.repository.userId, "github_401_during_action");
    throw new StepError(
      "GitHub rejected the stored authorization (401). Sign in again to resume automation.",
      false,
      {
        cause: err,
      },
    );
  }
  if (err.retryable) throw err;
  if (err.status === 404) {
    throw new StepError(
      `${item} was not found in ${ctx.repository.fullName} (deleted, transferred, or no access).`,
      false,
      {
        cause: err,
      },
    );
  }
  if (err.status === 410) {
    throw new StepError(`Issues are disabled for ${ctx.repository.fullName}.`, false, { cause: err });
  }
  if (err.status === 403) {
    throw new StepError(`GitHub denied the request (403): ${err.message}`, false, { cause: err });
  }
  throw new StepError(err.message, false, { cause: err });
}

/**
 * Adds the rule's label. Idempotent: if the issue already has it (GitHub label names are
 * case-insensitive), nothing is written. A label that does not exist in the repository is
 * a clear, permanent failure — we do not rely on GitHub's undocumented behaviour for
 * unknown labels, and a typo in a rule must not silently create new labels.
 */
async function addLabel(ctx: StepContext, token: string): Promise<GitHubStepResult> {
  const wanted = ctx.run.actionValue.trim();
  const issuePath = `${repoPath(ctx)}/issues/${ctx.subject.number}`;
  try {
    const current = await listAll<Label>(token, `${issuePath}/labels`, 1);
    const present = current.find((l) => l.name.toLowerCase() === wanted.toLowerCase());
    if (present) return { labelName: present.name, alreadyApplied: true };

    const repoLabels = await listAll<Label>(token, `${repoPath(ctx)}/labels`, MAX_LABEL_PAGES);
    const label = repoLabels.find((l) => l.name.toLowerCase() === wanted.toLowerCase());
    if (!label) {
      throw new StepError(
        `Label “${wanted}” does not exist in ${ctx.repository.fullName}. Create it under Issues → Labels, or change the rule.`,
        false,
      );
    }

    const after = await githubRequest<Label[]>(token, "POST", `${issuePath}/labels`, {
      labels: [label.name],
    });
    if (!after.some((l) => l.name.toLowerCase() === label.name.toLowerCase())) {
      // GitHub answered 200 but the label is not on the issue: report it rather than claim success.
      throw new StepError(`GitHub did not apply the label “${label.name}”.`, true);
    }
    return { labelName: label.name, alreadyApplied: false };
  } catch (err) {
    if (err instanceof StepError) throw err;
    return explain(err, ctx);
  }
}

/**
 * Posts the rule's comment with a hidden per-run marker. Before posting, recent comments by
 * the same account are checked for that marker, so a retry after a crash (comment posted,
 * result not yet recorded) does not post a duplicate.
 */
async function addComment(ctx: StepContext, token: string): Promise<GitHubStepResult> {
  const issuePath = `${repoPath(ctx)}/issues/${ctx.subject.number}`;
  const marker = commentMarker(ctx.run.id);
  const [owner] = await ctx.db
    .select({ login: users.githubLogin })
    .from(users)
    .where(eq(users.id, ctx.repository.userId))
    .limit(1);
  try {
    const since = new Date(ctx.run.createdAt.getTime() - COMMENT_LOOKBACK_MS).toISOString();
    const recent = await listAll<Comment>(
      token,
      `${issuePath}/comments?since=${encodeURIComponent(since)}`,
      MAX_COMMENT_PAGES,
    );
    const existing = recent.find(
      (c) =>
        c.body?.includes(marker) && (!owner || c.user?.login?.toLowerCase() === owner.login.toLowerCase()),
    );
    if (existing) return { commentId: existing.id, commentUrl: existing.html_url, alreadyApplied: true };

    const created = await githubRequest<Comment>(token, "POST", `${issuePath}/comments`, {
      body: commentBody(ctx.run.actionValue, ctx.run.ruleName, ctx.run.id),
    });
    return { commentId: created.id, commentUrl: created.html_url, alreadyApplied: false };
  } catch (err) {
    if (err instanceof StepError) throw err;
    return explain(err, ctx);
  }
}

/** The GitHub step of a run, performed with the repository owner's (refreshed) token. */
export async function executeGitHubAction(ctx: StepContext): Promise<GitHubStepResult> {
  const token = await getUserAccessToken(ctx.db, ctx.env, ctx.repository.userId);
  return ctx.run.actionType === "add_label" ? addLabel(ctx, token) : addComment(ctx, token);
}
