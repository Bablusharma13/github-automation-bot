import type { Metadata } from "next";
import { RulesManager } from "@/components/rules-manager";
import { requireUser } from "@/server/auth/dal";

export const metadata: Metadata = { title: "Rules · GitHub Automation Bot" };

export default async function RulesPage() {
  await requireUser();
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Rules</h1>
      <p className="mt-2 max-w-2xl text-stone-600">
        A rule watches one repository. When a matching issue or pull request event arrives, the bot adds a
        label or posts a comment, then optionally reports the outcome to Slack.
      </p>
      <RulesManager />
    </div>
  );
}
