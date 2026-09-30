import type { Metadata } from "next";
import { SlackSettings } from "@/components/slack-settings";
import { requireUser } from "@/server/auth/dal";

export const metadata: Metadata = { title: "Settings · GitHub Automation Bot" };

export default async function SettingsPage() {
  await requireUser();
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      <p className="mt-2 max-w-2xl text-stone-600">
        After a rule runs, the bot can post the outcome — success or failure — to Slack through an Incoming
        Webhook. Create one in Slack (api.slack.com/apps → your app → Incoming Webhooks) and paste it here.
      </p>
      <SlackSettings />
    </div>
  );
}
