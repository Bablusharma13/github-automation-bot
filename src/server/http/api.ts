import "server-only";
import type { NextRequest } from "next/server";
import type { z } from "zod";
import { getRequestUser, type AuthDeps } from "../auth/handlers";
import type { SessionUser } from "../auth/session";
import { consumeRateLimit } from "../rate-limit";
import { logger } from "../logger";
import { AppError, jsonError, toErrorResponse } from "./errors";
import { isSameOrigin } from "./request";

const MUTATION_RATE_LIMIT = { limit: 60, windowSeconds: 10 * 60 };

/**
 * Shared boundary for authenticated JSON API routes:
 * 1. same-origin check for mutations (CSRF), 2. session → user (401),
 * 3. per-user rate limit for mutations (429), 4. central error mapping.
 * Handlers receive the session user and must scope every query by `user.id`.
 */
export async function withUser(
  request: NextRequest,
  depsOrFactory: AuthDeps | (() => AuthDeps),
  route: string,
  handler: (user: SessionUser, deps: AuthDeps) => Promise<Response>,
): Promise<Response> {
  const isMutation = !["GET", "HEAD", "OPTIONS"].includes(request.method);
  try {
    // Resolved inside the try so a configuration error still yields a JSON 500.
    const deps = typeof depsOrFactory === "function" ? depsOrFactory() : depsOrFactory;
    if (isMutation && !isSameOrigin(request.headers, deps.env.APP_URL)) {
      logger.warn("cross_origin_request_rejected", { route });
      return jsonError(403, "forbidden", "Cross-origin request rejected.");
    }
    const user = await getRequestUser(request, deps);
    if (!user) return jsonError(401, "unauthenticated", "Not signed in.");

    if (isMutation) {
      const rl = await consumeRateLimit(
        deps.db,
        `api_mutation:${user.id}`,
        MUTATION_RATE_LIMIT.limit,
        MUTATION_RATE_LIMIT.windowSeconds,
      );
      if (!rl.allowed) {
        return jsonError(429, "rate_limited", "Too many changes in a short time. Please wait a moment.", {
          "Retry-After": String(rl.retryAfterSeconds),
        });
      }
    }
    return await handler(user, deps);
  } catch (err) {
    return toErrorResponse(err, { route });
  }
}

/** Parses and validates a JSON body; malformed input is a 400, never a 500. */
export async function parseJsonBody<T extends z.ZodType>(
  request: NextRequest,
  schema: T,
): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new AppError(400, "invalid_json", "Request body must be valid JSON.");
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
    throw new AppError(400, "invalid_input", `${where}${issue?.message ?? "Invalid input."}`);
  }
  return parsed.data;
}
