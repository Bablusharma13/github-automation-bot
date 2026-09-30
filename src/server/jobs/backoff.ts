/**
 * Exponential backoff with ±20% jitter: ~30s, 60s, 2m, 4m, 8m, … capped at 1h.
 * `attempt` is the number of attempts already made (1 after the first failure).
 * Jitter spreads retries out so a GitHub/Slack outage does not end in a thundering herd.
 */
export function retryDelaySeconds(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30 * 2 ** Math.max(attempt - 1, 0), 3600);
  const jitter = 1 + (random() * 0.4 - 0.2);
  return Math.max(1, Math.round(base * jitter));
}
