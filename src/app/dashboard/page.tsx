import type { Metadata } from "next";
import Link from "next/link";
import { requireUser } from "@/server/auth/dal";
import { getDb } from "@/server/db";
import { listRecentEvents } from "@/server/events/service";
import { listConnectedRepositories } from "@/server/repositories/service";

export const metadata: Metadata = { title: "Dashboard · GitHub Automation Bot" };

const STATUS_STYLES: Record<string, string> = {
  received: "bg-sky-50 text-sky-800",
  processing: "bg-sky-50 text-sky-800",
  processed: "bg-emerald-50 text-emerald-800",
  ignored: "bg-stone-100 text-stone-600",
  failed: "bg-red-50 text-red-800",
};

const STATUS_LABELS: Record<string, string> = {
  received: "queued",
  processing: "processing",
  processed: "processed",
  ignored: "ignored",
  failed: "failed",
};

export default async function DashboardPage() {
  const user = await requireUser();
  const db = getDb();
  const [repos, events] = await Promise.all([
    listConnectedRepositories(db, user.id),
    listRecentEvents(db, user.id, 10),
  ]);

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Welcome, {user.name ?? user.githubLogin}</h1>
      <p className="mt-2 text-stone-600">
        {repos.length === 0
          ? "Connect a repository to start automating issues and pull requests."
          : `${repos.length} connected ${repos.length === 1 ? "repository" : "repositories"}.`}
      </p>

      <section className="mt-8 rounded-lg border border-stone-200 bg-white p-5">
        <div className="flex items-center justify-between">
          <h2 className="font-medium">Connected repositories</h2>
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

      <section className="mt-6 rounded-lg border border-stone-200 bg-white p-5">
        <h2 className="font-medium">Recent webhook events</h2>
        {events.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500">
            No deliveries yet. Open an issue or pull request in a connected repository.
          </p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-100">
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div className="min-w-0">
                  <span className="font-mono text-xs text-stone-500">
                    {e.eventType}
                    {e.action ? `.${e.action}` : ""}
                  </span>{" "}
                  {e.subject ? (
                    <a href={e.subject.url} target="_blank" rel="noreferrer" className="hover:underline">
                      #{e.subject.number} {e.subject.title}
                    </a>
                  ) : (
                    <span className="text-stone-500">{e.repoFullName ?? "unknown repository"}</span>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[e.status] ?? ""}`}
                    title={e.ignoreReason ?? undefined}
                  >
                    {STATUS_LABELS[e.status] ?? e.status}
                    {e.ignoreReason ? ` · ${e.ignoreReason.replaceAll("_", " ")}` : ""}
                  </span>
                  <time className="text-xs text-stone-500" dateTime={e.receivedAt}>
                    {new Date(e.receivedAt).toLocaleString()}
                  </time>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
