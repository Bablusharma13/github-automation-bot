import { vi } from "vitest";

export type RecordedRequest = { method: string; url: URL; headers: Headers; body: string };
type Handler = (req: RecordedRequest) => Response | Promise<Response>;

/**
 * Replaces global fetch with a router keyed by "METHOD https://host/path" (query string
 * ignored). Any request without a matching route fails the test — nothing can reach the
 * real network by accident.
 */
export function mockFetch(routes: Record<string, Handler>) {
  const calls: RecordedRequest[] = [];
  const fn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const body = init?.body === undefined || init.body === null ? "" : String(init.body);
    const req = { method, url, headers, body };
    calls.push(req);
    const handler = routes[`${method} ${url.origin}${url.pathname}`];
    if (!handler) throw new Error(`Unexpected fetch in test: ${method} ${url.toString()}`);
    return handler(req);
  });
  vi.stubGlobal("fetch", fn);
  return { calls };
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
