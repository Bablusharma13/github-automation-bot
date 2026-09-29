import { NextResponse } from "next/server";
import { logger, serializeError } from "../logger";

/**
 * An error whose `message` is safe to show to the client. Anything else that reaches
 * the error boundary is reported as a generic 500 and logged server-side.
 */
export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
  }
}

export function jsonError(status: number, code: string, message: string, headers?: HeadersInit) {
  return NextResponse.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

/** Central mapping from thrown errors to safe client responses. */
export function toErrorResponse(err: unknown, context: Record<string, unknown> = {}) {
  if (err instanceof AppError) {
    if (err.status >= 500) {
      logger.error("request_failed", { ...context, code: err.code, error: serializeError(err) });
    }
    return jsonError(err.status, err.code, err.message);
  }
  logger.error("request_failed_unexpected", { ...context, error: serializeError(err) });
  return jsonError(500, "internal_error", "Something went wrong. Please try again.");
}
