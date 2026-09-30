import "server-only";
import { isSlackWebhookUrl } from "@/lib/slack-url";

export type SlackMessage = { text: string; blocks?: unknown[] };

/** A failed Slack delivery. `retryable`: network, timeout, 5xx and 429 (rate limit). */
export class SlackError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "SlackError";
  }
}

const TIMEOUT_MS = 10_000;

/**
 * POSTs to a Slack Incoming Webhook. Success is HTTP 200 with body "ok". Errors come back
 * as 4xx with a short code in the body (e.g. no_service, invalid_payload) and are
 * permanent; 429 (rate limited, ~1 message/second per webhook) and 5xx are retryable.
 * Redirects are never followed, so a response cannot bounce the request elsewhere.
 * The URL contains a secret and is never included in errors or logs.
 */
export async function postSlackMessage(webhookUrl: string, message: SlackMessage): Promise<void> {
  if (!isSlackWebhookUrl(webhookUrl)) {
    throw new SlackError("The Slack webhook URL is not a valid Incoming Webhook URL.", null, false);
  }
  let res: Response;
  try {
    res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch (err) {
    throw new SlackError("Could not reach Slack (network error or timeout).", null, true, { cause: err });
  }
  const body = (await res.text().catch(() => "")).trim().slice(0, 100);
  if (res.status === 200 && body === "ok") return;
  if (res.status >= 300 && res.status < 400) {
    throw new SlackError(`Slack answered with an unexpected redirect (${res.status}).`, res.status, false);
  }
  if (res.status === 429) {
    const retryAfter = res.headers.get("retry-after");
    throw new SlackError(
      `Slack rate limited the notification (429${retryAfter ? `, retry after ${retryAfter}s` : ""}).`,
      429,
      true,
    );
  }
  const retryable = res.status >= 500;
  throw new SlackError(
    `Slack rejected the notification (${res.status}${body ? `: ${body}` : ""}).`,
    res.status,
    retryable,
  );
}
