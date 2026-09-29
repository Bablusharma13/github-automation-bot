/**
 * Client IP for rate limiting. On Vercel, `x-forwarded-for` / `x-vercel-forwarded-for`
 * are overwritten by the platform (documented anti-spoofing behaviour), so the first
 * entry is the real client. Locally the header is usually absent.
 */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-vercel-forwarded-for") ?? headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first || headers.get("x-real-ip") || "unknown";
}

/**
 * CSRF defence for cookie-authenticated mutations: browsers always send `Origin` on
 * cross-origin and same-origin POST/PATCH/DELETE, and it cannot be forged by page script.
 * Combined with SameSite=Lax session cookies this blocks cross-site form/fetch attacks.
 */
export function isSameOrigin(headers: Headers, appUrl: string): boolean {
  const origin = headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}
