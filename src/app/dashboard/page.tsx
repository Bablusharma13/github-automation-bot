import type { Metadata } from "next";
import Link from "next/link";
import { ActivityFeed } from "@/components/activity-feed";
import { FailuresPanel } from "@/components/failures-panel";
import { StatsCards } from "@/components/stats-cards";
import { requireUser } from "@/server/auth/dal";
import { getDb } from "@/server/db";
import { listConnectedRepositories } from "@/server/repositories/service";

export const metadata: Metadata = { title: "Dashboard · GitHub Automation Bot" };

export default async function DashboardPage() {
  const user = await requireUser();
  const repos = await listConnectedRepositories(getDb(), user.id);

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Welcome, {user.name ?? user.githubLogin}</h1>
        <p className="mt-2 text-stone-600">
          {repos.length === 0 ? (
            <>
              Start by{" "}
              <Link href="/dashboard/repositories" className="underline">
                connecting a repository
              </Link>
              , then{" "}
              <Link href="/dashboard/rules" className="underline">
                add a rule
              </Link>
              .
            </>
          ) : (
            "Live overview of your automation."
          )}
        </p>
      </div>

      <StatsCards />

      <section aria-labelledby="recent-heading">
        <div className="mb-2 flex items-center justify-between">
          <h2 id="recent-heading" className="font-medium">
            Recent activity
          </h2>
          <Link href="/dashboard/activity" className="text-sm text-stone-600 underline hover:text-stone-900">
            View all
          </Link>
        </div>
        <ActivityFeed pageSize={8} compact />
      </section>

      <div className="grid gap-6 lg:grid-cols-2">
        <FailuresPanel />
        <section aria-labelledby="repos-heading" className="rounded-lg border border-stone-200 bg-white p-5">
          <div className="flex items-center justify-between">
            <h2 id="repos-heading" className="font-medium">
              Connected repositories
            </h2>
            <Link
              href="/dashboard/repositories"
              className="text-sm text-stone-600 underline hover:text-stone-900"
            >
              Manage
            </Link>
          </div>
          {repos.length === 0 ? (
            <p className="mt-3 text-sm text-stone-500">None yet.</p>
          ) : (
            <ul className="mt-3 divide-y divide-stone-100">
              {repos.map((r) => (
                <li key={r.id} className="flex items-center justify-between py-2 text-sm">
                  <a href={r.htmlUrl} target="_blank" rel="noreferrer" className="font-mono hover:underline">
                    {r.fullName}
                  </a>
                  <span className="text-xs text-stone-500">
                    {r.webhookInstalled ? "Webhook installed" : "No webhook"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
