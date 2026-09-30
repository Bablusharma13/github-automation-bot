/** Error returned by our JSON API (`{ error: { code, message } }`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/**
 * Same-origin JSON fetch for client components. The session cookie is HttpOnly and sent
 * automatically; the browser adds the `Origin` header the API checks on mutations.
 */
export async function apiFetch<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? "GET",
    headers: init.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: "same-origin",
    cache: "no-store",
  });
  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err =
      data && typeof data === "object" && "error" in data && data.error && typeof data.error === "object"
        ? (data.error as { code?: string; message?: string })
        : {};
    throw new ApiError(
      res.status,
      err.code ?? "http_error",
      err.message ?? `Request failed (${res.status}).`,
    );
  }
  return data as T;
}
