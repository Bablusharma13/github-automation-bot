import "server-only";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../db";
import { repositories, type Repository } from "../db/schema";
import type { Env } from "../env";
import { GitHubApiError } from "../github/api";
import {
  deleteRepoWebhook,
  ensureRepoWebhook,
  getRepo,
  listConnectableRepos,
  webhookUrl,
} from "../github/repos";
import { getUserAccessToken, GitHubReauthRequiredError } from "../github/user-token";
import { AppError } from "../http/errors";
import { logger, serializeError } from "../logger";

/** What the browser may see about a connected repository (no webhook secret, ever). */
export type RepositoryDTO = {
  id: string;
  githubRepoId: number;
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  htmlUrl: string;
  webhookInstalled: boolean;
  connectedAt: string;
};

export function toRepositoryDTO(r: Repository): RepositoryDTO {
  return {
    id: r.id,
    githubRepoId: r.githubRepoId,
    owner: r.owner,
    name: r.name,
    fullName: r.fullName,
    private: r.private,
    htmlUrl: r.htmlUrl,
    webhookInstalled: r.webhookId !== null,
    connectedAt: r.updatedAt.toISOString(),
  };
}

/** Maps GitHub/auth failures to safe, actionable client errors. */
function githubFailure(err: unknown, action: string): never {
  if (err instanceof AppError) throw err;
  if (err instanceof GitHubReauthRequiredError) {
    throw new AppError(401, "github_reauth_required", err.message, { cause: err });
  }
  if (err instanceof GitHubApiError) {
    if (err.status === 401) {
      throw new AppError(401, "github_reauth_required", "GitHub rejected your credentials. Sign in again.", {
        cause: err,
      });
    }
    if (err.status === 404 || err.status === 403) {
      throw new AppError(
        404,
        "repository_not_found",
        "Repository not found, or your account cannot access it.",
        {
          cause: err,
        },
      );
    }
    if (err.status === 422 && err.details.length > 0) {
      // GitHub's validation text is safe to show and explains e.g. an unreachable URL.
      throw new AppError(
        422,
        "github_validation_failed",
        `GitHub rejected the ${action}: ${err.details.join("; ")}`,
        {
          cause: err,
        },
      );
    }
  }
  throw new AppError(502, "github_unavailable", `Could not ${action} on GitHub. Please try again.`, {
    cause: err,
  });
}

function isUniqueViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && depth < 3; depth++) {
    if (typeof e === "object" && "code" in e && e.code === "23505") return true;
    e = typeof e === "object" && "cause" in e ? e.cause : undefined;
  }
  return false;
}

export async function listConnectedRepositories(db: Db, userId: string): Promise<RepositoryDTO[]> {
  const rows = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.userId, userId), eq(repositories.active, true)))
    .orderBy(desc(repositories.updatedAt));
  return rows.map(toRepositoryDTO);
}

export async function getConnectedRepository(db: Db, userId: string, id: string): Promise<RepositoryDTO> {
  const [row] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, id), eq(repositories.userId, userId), eq(repositories.active, true)))
    .limit(1);
  // 404 (not 403) for other users' repositories: don't confirm that the id exists.
  if (!row) throw new AppError(404, "not_found", "Repository not found.");
  return toRepositoryDTO(row);
}

export type ConnectableRepository = {
  githubRepoId: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  htmlUrl: string;
  pushedAt: string | null;
  connected: boolean;
};

export async function listConnectableRepositories(
  db: Db,
  env: Env,
  userId: string,
): Promise<{ repositories: ConnectableRepository[]; webhookUrl: string }> {
  let repos;
  try {
    const token = await getUserAccessToken(db, env, userId);
    repos = await listConnectableRepos(token);
  } catch (err) {
    githubFailure(err, "list repositories");
  }
  const connected = new Set((await listConnectedRepositories(db, userId)).map((r) => r.githubRepoId));
  return {
    webhookUrl: webhookUrl(env),
    repositories: repos.map((r) => ({
      githubRepoId: r.id,
      fullName: r.full_name,
      owner: r.owner.login,
      name: r.name,
      description: r.description,
      htmlUrl: r.html_url,
      pushedAt: r.pushed_at,
      connected: connected.has(r.id),
    })),
  };
}

/**
 * Connect flow: verify access on GitHub (never trust the client), refuse repos another
 * account already owns, install/repair the webhook, then persist. If persisting fails
 * after we created a hook, the hook is removed again so nothing is left orphaned.
 */
export async function connectRepository(
  db: Db,
  env: Env,
  userId: string,
  fullName: string,
): Promise<{ repository: RepositoryDTO; created: boolean }> {
  const [owner, name] = fullName.split("/") as [string, string];

  let token: string;
  let repo;
  try {
    token = await getUserAccessToken(db, env, userId);
    repo = await getRepo(token, owner, name);
  } catch (err) {
    githubFailure(err, "look up the repository");
  }

  if (repo.private) {
    throw new AppError(
      422,
      "private_repository_unsupported",
      "Private repositories are not supported (this app only requests public repository access).",
    );
  }
  if (repo.archived) {
    throw new AppError(
      422,
      "repository_archived",
      "Archived repositories are read-only and cannot be automated.",
    );
  }
  if (!repo.permissions.admin) {
    throw new AppError(
      403,
      "insufficient_permission",
      "You need admin access to this repository to install the webhook.",
    );
  }

  const [existing] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.githubRepoId, repo.id), eq(repositories.active, true)))
    .limit(1);
  if (existing && existing.userId !== userId) {
    throw new AppError(
      409,
      "repository_connected_elsewhere",
      "This repository is already connected by another account.",
    );
  }
  if (existing && existing.webhookId !== null) {
    return { repository: toRepositoryDTO(existing), created: false };
  }

  let hook;
  try {
    hook = await ensureRepoWebhook(token, env, repo.owner.login, repo.name);
  } catch (err) {
    githubFailure(err, "webhook installation");
  }

  const values = {
    userId,
    githubRepoId: repo.id,
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    private: repo.private,
    htmlUrl: repo.html_url,
    webhookId: hook.hookId,
    active: true,
  };
  try {
    const [row] = await db
      .insert(repositories)
      .values(values)
      .onConflictDoUpdate({
        target: [repositories.userId, repositories.githubRepoId],
        set: { ...values, updatedAt: new Date() },
      })
      .returning();
    logger.info("repository_connected", {
      userId,
      repository: repo.full_name,
      hookId: hook.hookId,
      hookCreated: hook.created,
    });
    return { repository: toRepositoryDTO(row!), created: true };
  } catch (err) {
    // Only remove a hook we created in this request — a pre-existing one may belong to a
    // concurrent connection.
    if (hook.created) {
      await deleteRepoWebhook(token, repo.owner.login, repo.name, hook.hookId).catch((cleanupErr) =>
        logger.error("webhook_cleanup_failed", {
          repository: repo.full_name,
          hookId: hook.hookId,
          error: serializeError(cleanupErr),
        }),
      );
    }
    if (isUniqueViolation(err)) {
      throw new AppError(
        409,
        "repository_connected_elsewhere",
        "This repository is already connected by another account.",
      );
    }
    throw err;
  }
}

/**
 * Disconnect: remove our webhook from GitHub, then deactivate locally. History (events,
 * runs, rules) is kept. If GitHub cannot be reached, the repository is still deactivated
 * — incoming deliveries for inactive repositories are ignored — and the response says
 * the webhook may need manual removal instead of pretending it was removed.
 */
export async function disconnectRepository(
  db: Db,
  env: Env,
  userId: string,
  id: string,
): Promise<{ webhookRemoved: boolean; warning?: string }> {
  const [repo] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, id), eq(repositories.userId, userId), eq(repositories.active, true)))
    .limit(1);
  if (!repo) throw new AppError(404, "not_found", "Repository not found.");

  let webhookRemoved = true;
  let warning: string | undefined;
  if (repo.webhookId !== null) {
    try {
      const token = await getUserAccessToken(db, env, userId);
      await deleteRepoWebhook(token, repo.owner, repo.name, repo.webhookId);
    } catch (err) {
      webhookRemoved = false;
      warning =
        "The repository was disconnected, but its webhook could not be removed from GitHub. " +
        "Deliveries will be ignored; you can delete the webhook in the repository's Settings → Webhooks.";
      logger.warn("webhook_delete_failed", { repository: repo.fullName, error: serializeError(err) });
    }
  }

  await db
    .update(repositories)
    .set({ active: false, webhookId: webhookRemoved ? null : repo.webhookId, updatedAt: new Date() })
    .where(and(eq(repositories.id, id), eq(repositories.userId, userId)));
  logger.info("repository_disconnected", { userId, repository: repo.fullName, webhookRemoved });
  return { webhookRemoved, ...(warning ? { warning } : {}) };
}
