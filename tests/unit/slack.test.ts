import { afterEach, describe, expect, it, vi } from "vitest";
import type { AutomationRun } from "@/server/db/schema";
import { isSlackWebhookUrl } from "@/lib/slack-url";
import { postSlackMessage, SlackError } from "@/server/slack/client";
import { buildRunNotification, escapeSlack } from "@/server/slack/message";
import { json, mockFetch } from "../helpers/fetch-mock";

const HOOK = "https://hooks.slack.com/services/T000/B000/XXXXXXXX";

afterEach(() => vi.unstubAllGlobals());

describe("isSlackWebhookUrl (SSRF guard)", () => {
  it("accepts Slack Incoming Webhook URLs", () => {
    expect(isSlackWebhookUrl(HOOK)).toBe(true);
  });
  it.each([
    "http://hooks.slack.com/services/T0/B0/X",
    "https://hooks.slack.com.evil.example/services/T0/B0/X",
    // Hosts that merely end in "slack.com" are not the webhook host.
    "https://evilslack.com/services/T0/B0/X",
    "https://files.slack.com/services/T0/B0/X",
    "https://evil.example/hooks.slack.com/services/T0/B0/X",
    "https://user:pass@hooks.slack.com/services/T0/B0/X",
    "https://hooks.slack.com:8443/services/T0/B0/X",
    "https://hooks.slack.com/api/chat.postMessage",
    "https://hooks.slack.com/services/T0/B0/X?redirect=http://169.254.169.254",
    "https://127.0.0.1/services/T0/B0/X",
    "https://hooks.slack.com/services/../../admin",
    "not a url",
    "",
  ])("rejects %s", (url) => {
    expect(isSlackWebhookUrl(url)).toBe(false);
  });
});

describe("postSlackMessage", () => {
  it("succeeds on 200 ok and sends JSON without following redirects", async () => {
    const slack = mockFetch({ [`POST ${HOOK}`]: () => new Response("ok", { status: 200 }) });
    await postSlackMessage(HOOK, { text: "hi" });
    expect(JSON.parse(slack.calls[0]!.body)).toEqual({ text: "hi" });
  });

  it("treats 4xx errors as permanent with Slack's reason", async () => {
    mockFetch({ [`POST ${HOOK}`]: () => new Response("no_service", { status: 404 }) });
    const err = await postSlackMessage(HOOK, { text: "hi" }).catch((e) => e);
    expect(err).toBeInstanceOf(SlackError);
    expect(err).toMatchObject({ status: 404, retryable: false });
    expect(err.message).toMatch(/404: no_service/);
    expect(err.message).not.toContain("hooks.slack.com"); // the URL is a secret
  });

  it("treats 429 and 5xx as retryable", async () => {
    mockFetch({
      [`POST ${HOOK}`]: () => new Response("rate_limited", { status: 429, headers: { "retry-after": "30" } }),
    });
    expect(await postSlackMessage(HOOK, { text: "x" }).catch((e) => e)).toMatchObject({
      retryable: true,
      status: 429,
    });
    vi.unstubAllGlobals();
    mockFetch({ [`POST ${HOOK}`]: () => new Response("rollup_error", { status: 500 }) });
    expect(await postSlackMessage(HOOK, { text: "x" }).catch((e) => e)).toMatchObject({ retryable: true });
  });

  it("treats network errors as retryable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(await postSlackMessage(HOOK, { text: "x" }).catch((e) => e)).toMatchObject({ retryable: true });
  });

  it("does not treat a redirect or a non-'ok' 200 as success", async () => {
    mockFetch({
      [`POST ${HOOK}`]: () => new Response(null, { status: 302, headers: { location: "https://x" } }),
    });
    expect(await postSlackMessage(HOOK, { text: "x" }).catch((e) => e)).toMatchObject({ retryable: false });
    vi.unstubAllGlobals();
    mockFetch({ [`POST ${HOOK}`]: () => json({ unexpected: true }) });
    expect(await postSlackMessage(HOOK, { text: "x" }).catch((e) => e)).toBeInstanceOf(SlackError);
  });

  it("refuses to call anything that is not a Slack webhook", async () => {
    const guard = mockFetch({});
    const err = await postSlackMessage("https://169.254.169.254/latest/meta-data", { text: "x" }).catch(
      (e) => e,
    );
    expect(err).toMatchObject({ retryable: false });
    expect(guard.calls).toHaveLength(0);
  });
});

describe("buildRunNotification", () => {
  const baseRun = {
    id: "run-1",
    ruleName: "Bug issue automation",
    actionType: "add_label",
    actionValue: "bug",
    githubStatus: "succeeded",
    githubResult: { labelName: "bug", alreadyApplied: false },
    githubError: null,
  } as unknown as AutomationRun;
  const subject = {
    kind: "issue" as const,
    number: 12,
    title: "Bug: login fails",
    body: "",
    url: "https://github.com/o/r/issues/12",
    state: "open",
    author: "octocat",
    labels: [],
  };
  const flatten = (m: { text: string; blocks?: unknown[] }) => JSON.stringify(m);

  it("reports a successful label with repository, event, author, rule and status", () => {
    const m = buildRunNotification({
      run: baseRun,
      event: { action: "opened" },
      subject,
      repository: { fullName: "o/r" },
    });
    expect(m.text).toBe("✅ Bug issue automation: Added label `bug` on issue #12 in o/r");
    const all = flatten(m);
    for (const part of [
      "*Repository*\\no/r",
      "*Event*\\nIssue opened",
      "*Author*\\noctocat",
      "*Matched rule*\\nBug issue automation",
      "✅ Success",
      "<https://github.com/o/r/issues/12|#12 Bug: login fails>",
    ]) {
      expect(all).toContain(part);
    }
  });

  it("reports failures with the error", () => {
    const run = {
      ...baseRun,
      githubStatus: "failed",
      githubResult: null,
      githubError: "Label “bug” does not exist",
    } as AutomationRun;
    const m = buildRunNotification({
      run,
      event: { action: "opened" },
      subject,
      repository: { fullName: "o/r" },
    });
    expect(m.text).toMatch(/^❌ Bug issue automation: could not add a label to issue #12 in o\/r$/);
    expect(flatten(m)).toContain("❌ Failed");
    expect(flatten(m)).toContain("Label “bug” does not exist");
  });

  it("escapes user-controlled text so it cannot ping channels or inject links", () => {
    const evil = { ...subject, title: "<!channel> pwn <https://evil.example|click>", author: "<@U123>" };
    const run = { ...baseRun, ruleName: "<!here>" } as AutomationRun;
    const all = flatten(
      buildRunNotification({
        run,
        event: { action: "opened" },
        subject: evil,
        repository: { fullName: "o/r" },
      }),
    );
    expect(all).not.toMatch(/<!channel>|<!here>|<@U123>|<https:\/\/evil/);
    expect(all).toContain("&lt;!channel&gt;");
    expect(escapeSlack("a & b < c > d")).toBe("a &amp; b &lt; c &gt; d");
  });

  it("links comments and notes already-applied labels", () => {
    const commentRun = {
      ...baseRun,
      actionType: "add_comment",
      actionValue: "Thanks",
      githubResult: {
        commentId: 5,
        commentUrl: "https://github.com/o/r/issues/12#issuecomment-5",
        alreadyApplied: false,
      },
    } as AutomationRun;
    expect(
      flatten(
        buildRunNotification({
          run: commentRun,
          event: { action: "opened" },
          subject,
          repository: { fullName: "o/r" },
        }),
      ),
    ).toContain("<https://github.com/o/r/issues/12#issuecomment-5|Posted a comment>");
    const already = { ...baseRun, githubResult: { labelName: "bug", alreadyApplied: true } } as AutomationRun;
    expect(
      buildRunNotification({
        run: already,
        event: { action: "opened" },
        subject,
        repository: { fullName: "o/r" },
      }).text,
    ).toContain("was already present");
  });
});
