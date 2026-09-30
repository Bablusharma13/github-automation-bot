/**
 * An automation step failure with an explicit retry decision. GitHubApiError,
 * GitHubReauthRequiredError and OAuthError also carry `retryable`; anything without the
 * flag (unexpected errors) is treated as transient and retried until attempts run out.
 */
export class StepError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StepError";
  }
}

export function isRetryable(err: unknown): boolean {
  if (err && typeof err === "object" && "retryable" in err && typeof err.retryable === "boolean") {
    return err.retryable;
  }
  return true;
}

/** Short, storable description of a failure (shown in the dashboard). Never includes tokens. */
export function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\nparams:")[0]!.slice(0, 500) || "Unknown error";
}
