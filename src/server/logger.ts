/**
 * Minimal structured JSON logger. One line per event so Vercel runtime logs stay
 * searchable (e.g. `event:"github_webhook_rejected"`).
 *
 * Keys that commonly carry secrets are redacted recursively. Callers should still avoid
 * passing secrets or whole payloads in the first place; redaction is a safety net.
 */
type Level = "debug" | "info" | "warn" | "error";

const REDACTED = "[REDACTED]";
// Substrings that mark a secret-bearing key (accessToken, clientSecret, slackWebhookUrl...).
const SENSITIVE_SUBSTRING = /(secret|token|password|api[_-]?key|webhook[_-]?url|code_verifier)/i;
// Header-like keys matched exactly, so descriptive flags such as `hadCookie` stay visible.
const SENSITIVE_EXACT = /^(authorization|cookie|cookies|set-cookie|signature|x-hub-signature(-256)?)$/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_SUBSTRING.test(key) || SENSITIVE_EXACT.test(key);
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

/**
 * Drizzle's query errors embed the SQL *and its bound parameters* in `message`
 * ("Failed query: ...\nparams: ..."). Parameters can hold personal data (e.g. the client
 * IP in a rate-limit key), so they are cut off; the underlying driver error (`cause`,
 * e.g. ECONNREFUSED or SQLSTATE 23505) is what is actually useful for debugging.
 */
function safeMessage(message: string): string {
  return message.split("\nparams:")[0]!.slice(0, 500);
}

export function serializeError(err: unknown, depth = 0): Record<string, unknown> {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const status = (err as { status?: unknown }).status;
    return {
      name: err.name,
      message: safeMessage(err.message),
      ...(typeof code === "string" || typeof code === "number" ? { code } : {}),
      ...(typeof status === "number" ? { status } : {}),
      ...(err.cause !== undefined && depth < 2 ? { cause: serializeError(err.cause, depth + 1) } : {}),
      ...(process.env.NODE_ENV !== "production" && err.stack && depth === 0
        ? { stack: err.stack.replace(/\nparams:[\s\S]*?(?=\n\s+at )/, "") }
        : {}),
    };
  }
  return { message: safeMessage(String(err)) };
}

function write(level: Level, event: string, fields: Record<string, unknown> = {}) {
  if (level === "debug" && process.env.NODE_ENV === "production") return;
  if (process.env.NODE_ENV === "test" && !process.env.LOG_IN_TESTS) return;
  const line = JSON.stringify({
    level,
    event,
    timestamp: new Date().toISOString(),
    ...(redact(fields) as Record<string, unknown>),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (event: string, fields?: Record<string, unknown>) => write("debug", event, fields),
  info: (event: string, fields?: Record<string, unknown>) => write("info", event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => write("warn", event, fields),
  error: (event: string, fields?: Record<string, unknown>) => write("error", event, fields),
};

export const __test__ = { redact };
