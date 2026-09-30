/**
 * Only Slack Incoming Webhook URLs are accepted: https, host exactly hooks.slack.com,
 * default port, no credentials, path under /services/. The server POSTs to this URL, so
 * anything looser would let a user make it call arbitrary (e.g. internal) addresses (SSRF).
 * Client-safe: used for form validation too.
 */
export function isSlackWebhookUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "hooks.slack.com" &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    /^\/services\/[A-Za-z0-9/_-]+$/.test(url.pathname) &&
    url.search === "" &&
    url.hash === ""
  );
}
