import "server-only";
import { z } from "zod";
import type { Env } from "../env";
import { GitHubApiError, githubRequest } from "./api";

const repoSchema = z.object({
  id: z.number().int().positive(),
  name: z.string().min(1),
  full_name: z.string().min(1),
  private: z.boolean(),
  archived: z.boolean().default(false),
  html_url: z.url(),
  description: z.string().nullable().default(null),
  owner: z.object({ login: z.string().min(1) }),
  permissions: z
    .object({ admin: z.boolean().default(false), push: z.boolean().default(false) })
    .default({ admin: false, push: false }),
  pushed_at: z.string().nullable().default(null),
});

export type GitHubRepo = z.infer<typeof repoSchema>;

const MAX_PAGES = 3; // up to 300 repositories; plenty for this app, bounded request time

/**
 * Repositories the user can connect: public (our OAuth scope is `public_repo`), not
 * archived (archived repos are read-only), and administered by the user (creating a
 * repository webhook requires admin).
 */
export async function listConnectableRepos(token: string): Promise<GitHubRepo[]> {
  const repos: GitHubRepo[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = new URLSearchParams({
      visibility: "public",
      affiliation: "owner,collaborator,organization_member",
      sort: "updated",
      per_page: "100",
      page: String(page),
    });
    const data = await githubRequest<unknown[]>(token, "GET", `/user/repos?${query}`);
    const batch = z.array(repoSchema).safeParse(data);
    if (!batch.success)
      throw new GitHubApiError("GitHub /user/repos returned an unexpected shape", 200, false);
    repos.push(...batch.data);
    if (batch.data.length < 100) break;
  }
  return repos.filter((r) => !r.private && !r.archived && r.permissions.admin);
}

export async function getRepo(token: string, owner: string, name: string): Promise<GitHubRepo> {
  const data = await githubRequest(
    token,
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
  );
  const parsed = repoSchema.safeParse(data);
  if (!parsed.success)
    throw new GitHubApiError("GitHub repository response had an unexpected shape", 200, false);
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Repository webhooks
// ---------------------------------------------------------------------------

export const WEBHOOK_EVENTS = ["issues", "pull_request"] as const;

export function webhookUrl(env: Pick<Env, "APP_URL" | "GITHUB_WEBHOOK_URL">): string {
  return env.GITHUB_WEBHOOK_URL ?? `${env.APP_URL}/api/webhooks/github`;
}

function hookPath(owner: string, name: string) {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks`;
}

/**
 * Creates our webhook on the repository, or — if one with the same URL already exists
 * (e.g. left behind by an earlier connection) — updates it so its secret and events are
 * guaranteed to match ours. GitHub drops the secret on PATCH unless it is re-sent, so the
 * full config is always included. The secret is never logged or returned.
 */
export async function ensureRepoWebhook(
  token: string,
  env: Pick<Env, "APP_URL" | "GITHUB_WEBHOOK_URL" | "GITHUB_WEBHOOK_SECRET">,
  owner: string,
  name: string,
): Promise<{ hookId: number; created: boolean }> {
  const url = webhookUrl(env);
  const body = {
    active: true,
    events: [...WEBHOOK_EVENTS],
    config: { url, content_type: "json", secret: env.GITHUB_WEBHOOK_SECRET, insecure_ssl: "0" },
  };
  try {
    const hook = await githubRequest<{ id: number }>(token, "POST", hookPath(owner, name), {
      name: "web",
      ...body,
    });
    return { hookId: hook.id, created: true };
  } catch (err) {
    const alreadyExists =
      err instanceof GitHubApiError &&
      err.status === 422 &&
      err.details.some((d) => /already exists/i.test(d));
    if (!alreadyExists) throw err;

    const hooks = await githubRequest<Array<{ id: number; config?: { url?: string } }>>(
      token,
      "GET",
      `${hookPath(owner, name)}?per_page=100`,
    );
    const existing = hooks.find((h) => h.config?.url === url);
    if (!existing) throw err;
    await githubRequest(token, "PATCH", `${hookPath(owner, name)}/${existing.id}`, body);
    return { hookId: existing.id, created: false };
  }
}

/** Deletes our webhook. A 404 means it is already gone, which is the desired end state. */
export async function deleteRepoWebhook(
  token: string,
  owner: string,
  name: string,
  hookId: number,
): Promise<"deleted" | "already_gone"> {
  try {
    await githubRequest(token, "DELETE", `${hookPath(owner, name)}/${hookId}`);
    return "deleted";
  } catch (err) {
    if (err instanceof GitHubApiError && err.status === 404) return "already_gone";
    throw err;
  }
}
