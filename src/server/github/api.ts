import "server-only";

export const GITHUB_API_URL = "https://api.github.com";
/** Latest supported REST API version (verified 2026-09-29; no end-of-support date yet). */
export const GITHUB_API_VERSION = "2026-03-10";
export const USER_AGENT = "github-automation-bot";
const REQUEST_TIMEOUT_MS = 10_000;

/**
 * A failed GitHub API call. `retryable` distinguishes transient failures (network,
 * timeouts, 5xx, rate limits) from permanent ones (validation, missing permission).
 * `message` contains GitHub's own error text, never request headers or tokens.
 */
export class GitHubApiError extends Error {
  /** GitHub's validation messages (`errors[].message`), e.g. "Hook already exists on this repository". */
  readonly details: string[];
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    options?: { cause?: unknown; details?: string[] },
  ) {
    super(message, options);
    this.name = "GitHubApiError";
    this.details = options?.details ?? [];
  }
}

/** 422 responses put the useful text in `errors[]`, not in the top-level `message`. */
function validationDetails(data: unknown): string[] {
  if (!data || typeof data !== "object" || !("errors" in data) || !Array.isArray(data.errors)) return [];
  return data.errors
    .map((e: unknown) => {
      if (typeof e === "string") return e;
      if (e && typeof e === "object") {
        if ("message" in e && typeof e.message === "string") return e.message;
        if ("code" in e && typeof e.code === "string") return e.code;
      }
      return null;
    })
    .filter((m): m is string => Boolean(m))
    .map((m) => m.slice(0, 200))
    .slice(0, 5);
}

function isRateLimited(res: Response): boolean {
  if (res.status === 429) return true;
  return (
    res.status === 403 && (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.has("retry-after"))
  );
}

export async function githubRequest<T = unknown>(
  token: string,
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${GITHUB_API_URL}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": USER_AGENT,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    throw new GitHubApiError(
      `GitHub request failed: ${method} ${path} (network error or timeout)`,
      null,
      true,
      {
        cause: err,
      },
    );
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }

  if (!res.ok) {
    const githubMessage =
      data && typeof data === "object" && "message" in data && typeof data.message === "string"
        ? data.message.slice(0, 300)
        : res.statusText;
    const details = validationDetails(data);
    const retryable = res.status >= 500 || isRateLimited(res);
    throw new GitHubApiError(
      `GitHub ${method} ${path} → ${res.status}: ${githubMessage}${details.length ? ` (${details.join("; ")})` : ""}`,
      res.status,
      retryable,
      { details },
    );
  }
  return data as T;
}
