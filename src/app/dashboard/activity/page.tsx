import type { Metadata } from "next";
import { ActivityFeed } from "@/components/activity-feed";
import { requireUser } from "@/server/auth/dal";

export const metadata: Metadata = { title: "Activity · GitHub Automation Bot" };

export default async function ActivityPage() {
  await requireUser();
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
      <p className="mt-2 max-w-2xl text-stone-600">
        Every webhook delivery from your connected repositories, what the rules did with it, and whether
        GitHub and Slack succeeded. Select an event for the full timeline.
      </p>
      <div className="mt-6">
        <ActivityFeed />
      </div>
    </div>
  );
}
