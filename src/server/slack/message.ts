import type { AutomationRun, EventSubject, Repository, WebhookEvent } from "../db/schema";
import type { SlackMessage } from "./client";

/**
 * Slack treats &, < and > as control characters (links, @mentions, <!channel>). Titles,
 * logins and error text come from GitHub users, so they are escaped — otherwise an issue
 * titled "<!channel>" would ping everyone in the channel.
 */
export function escapeSlack(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function link(url: string, text: string): string {
  // Only GitHub URLs become links; anything else is shown as plain (escaped) text.
  return /^https:\/\/github\.com\/[^\s|<>]+$/.test(url) ? `<${url}|${escapeSlack(text)}>` : escapeSlack(text);
}

function describeAction(run: AutomationRun): string {
  const value = escapeSlack(clip(run.actionValue, 100));
  const result = run.githubResult;
  if (run.actionType === "add_label") {
    if (run.githubStatus !== "succeeded") return `Add label \`${value}\``;
    return result?.alreadyApplied
      ? `Label \`${escapeSlack(result.labelName ?? run.actionValue)}\` was already present`
      : `Added label \`${escapeSlack(result?.labelName ?? run.actionValue)}\``;
  }
  if (run.githubStatus !== "succeeded") return "Post a comment";
  const verb = result?.alreadyApplied ? "Comment already posted" : "Posted a comment";
  return result?.commentUrl ? link(result.commentUrl, verb) : verb;
}

export type NotificationInput = {
  run: AutomationRun;
  event: Pick<WebhookEvent, "action">;
  subject: EventSubject;
  repository: Pick<Repository, "fullName">;
};

/** The notification for one automation run, reporting the GitHub step's real outcome. */
export function buildRunNotification({ run, event, subject, repository }: NotificationInput): SlackMessage {
  const ok = run.githubStatus === "succeeded";
  const kind = subject.kind === "pull_request" ? "Pull request" : "Issue";
  const item = `${kind.toLowerCase()} #${subject.number}`;
  const repo = escapeSlack(repository.fullName);
  const title = clip(subject.title, 200);
  const action = describeAction(run);

  // The fallback `text` (notifications, screen readers) is parsed as mrkdwn too, so it is
  // built from escaped parts; link markup is reduced to its label.
  const rule = escapeSlack(clip(run.ruleName, 100));
  const plainAction = action.replace(/<[^|>]+\|([^>]+)>/g, "$1");
  const text = ok
    ? `✅ ${rule}: ${plainAction} on ${item} in ${repo}`
    : `❌ ${rule}: could not ${run.actionType === "add_label" ? "add a label to" : "comment on"} ${item} in ${repo}`;

  const fields = [
    { type: "mrkdwn", text: `*Repository*\n${repo}` },
    { type: "mrkdwn", text: `*Event*\n${kind} ${escapeSlack(event.action ?? "event")}` },
    { type: "mrkdwn", text: `*Author*\n${escapeSlack(subject.author ?? "unknown")}` },
    { type: "mrkdwn", text: `*Matched rule*\n${escapeSlack(clip(run.ruleName, 100))}` },
    { type: "mrkdwn", text: `*Action*\n${action}` },
    { type: "mrkdwn", text: `*Status*\n${ok ? "✅ Success" : "❌ Failed"}` },
  ];

  const blocks: unknown[] = [
    { type: "header", text: { type: "plain_text", text: "GitHub Automation Bot" } },
    {
      type: "section",
      text: { type: "mrkdwn", text: `*${link(subject.url, `#${subject.number} ${title}`)}*` },
    },
    { type: "section", fields },
  ];
  if (!ok && run.githubError) {
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `*Error*\n${escapeSlack(clip(run.githubError, 500))}` },
    });
  }
  return { text: clip(text, 300), blocks };
}

export function buildTestNotification(githubLogin: string): SlackMessage {
  const who = escapeSlack(githubLogin);
  return {
    text: `Test notification from GitHub Automation Bot for ${githubLogin}.`,
    blocks: [
      { type: "header", text: { type: "plain_text", text: "GitHub Automation Bot" } },
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `✅ Test notification. Automation results for *${who}*'s rules will be posted here.`,
        },
      },
    ],
  };
}
