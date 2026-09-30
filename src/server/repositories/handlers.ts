import "server-only";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import type { AuthDeps } from "../auth/handlers";
import { parseJsonBody, withUser } from "../http/api";
import { AppError } from "../http/errors";
import {
  connectRepository,
  disconnectRepository,
  getConnectedRepository,
  listConnectableRepositories,
  listConnectedRepositories,
} from "./service";

type Deps = AuthDeps | (() => AuthDeps);

const noStore = { "Cache-Control": "no-store" };

// GitHub owner: alphanumerics and single hyphens (≤39); repo: alphanumerics, '.', '-', '_' (≤100).
// Strict: the repository's id, owner and permissions always come from GitHub, so any other
// field (e.g. a client-supplied githubRepoId or userId) is rejected rather than ignored.
const connectSchema = z.strictObject({
  fullName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/, "must look like owner/repository"),
});

const idSchema = z.uuid();

function parseId(id: string): string {
  const parsed = idSchema.safeParse(id);
  // Same response as "not yours" so ids cannot be probed.
  if (!parsed.success) throw new AppError(404, "not_found", "Repository not found.");
  return parsed.data;
}

/** GET /api/repositories — the signed-in user's connected repositories. */
export function listRepositoriesHandler(request: NextRequest, deps: Deps) {
  return withUser(request, deps, "repositories_list", async (user, { db }) =>
    NextResponse.json({ repositories: await listConnectedRepositories(db, user.id) }, { headers: noStore }),
  );
}

/** POST /api/repositories { fullName } — verify on GitHub, install webhook, persist. */
export function connectRepositoryHandler(request: NextRequest, deps: Deps) {
  return withUser(request, deps, "repositories_connect", async (user, { db, env }) => {
    const { fullName } = await parseJsonBody(request, connectSchema);
    const result = await connectRepository(db, env, user.id, fullName);
    return NextResponse.json(result, { status: result.created ? 201 : 200, headers: noStore });
  });
}

/** GET /api/repositories/:id */
export function getRepositoryHandler(request: NextRequest, deps: Deps, id: string) {
  return withUser(request, deps, "repositories_get", async (user, { db }) =>
    NextResponse.json(
      { repository: await getConnectedRepository(db, user.id, parseId(id)) },
      { headers: noStore },
    ),
  );
}

/** DELETE /api/repositories/:id */
export function disconnectRepositoryHandler(request: NextRequest, deps: Deps, id: string) {
  return withUser(request, deps, "repositories_disconnect", async (user, { db, env }) =>
    NextResponse.json(await disconnectRepository(db, env, user.id, parseId(id)), { headers: noStore }),
  );
}

/** GET /api/github/repositories — repositories on GitHub the user could connect. */
export function listConnectableHandler(request: NextRequest, deps: Deps) {
  return withUser(request, deps, "github_repositories_list", async (user, { db, env }) =>
    NextResponse.json(await listConnectableRepositories(db, env, user.id), { headers: noStore }),
  );
}
