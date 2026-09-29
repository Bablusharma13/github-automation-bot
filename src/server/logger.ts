/**
 * Minimal structured JSON logger. One line per event so Vercel runtime logs stay
 * searchable (e.g. `event:"github_webhook_rejected"`).
 *
 * Keys that commonly carry secrets are redacted recursively. Callers should still avoid
 * passing secrets or whole payloads in the first place; redaction is a safety net.
 */
type Level = "debug" | "info" | "warn" | "error";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY =
  /(secret|token|password|authorization|cookie|api[_-]?key|webhook[_-]?url|signature|code_verifier)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 5 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export function serializeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      ...(process.env.NODE_ENV !== "production" && err.stack ? { stack: err.stack } : {}),
    };
  }
  return { message: String(err) };
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
