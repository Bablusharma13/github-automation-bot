"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { EventDTO } from "@/lib/activity-types";
import { apiFetch } from "@/lib/api-client";
import { formatDateTime, timeAgo } from "@/lib/format";

type Failure = { eventId: string; what: string; reason: string; attempts: number; at: string };

function failuresOf(e: EventDTO): Failure[] {
  const where = e.subject ? `#${e.subject.number} in ${e.repoFullName}` : (e.repoFullName ?? "");
  const out: Failure[] = [];
  for (const r of e.runs) {
    if (r.githubStatus === "failed") {
      out.push({
        eventId: e.id,
        what: `${r.ruleName}: GitHub ${r.actionType === "add_label" ? "label" : "comment"} on ${where}`,
        reason: r.githubError ?? "Unknown error",
        attempts: r.githubAttempts,
        at: r.completedAt ?? r.createdAt,
      });
    }
    if (r.slackStatus === "failed") {
      out.push({
        eventId: e.id,
        what: `${r.ruleName}: Slack notification for ${where}`,
        reason: r.slackError ?? "Unknown error",
        attempts: r.slackAttempts,
        at: r.completedAt ?? r.createdAt,
      });
    }
  }
  if (e.status === "failed" && out.length === 0) {
    out.push({
      eventId: e.id,
      what: `Processing ${where}`,
      reason: e.errorMessage ?? e.job?.lastError ?? "Unknown error",
      attempts: e.job?.attempts ?? 0,
      at: e.processedAt ?? e.receivedAt,
    });
  }
  return out;
}

/** Most recent failures with reason, retry count and time; each links to the event. */
export function FailuresPanel() {
  const query = useQuery({
    queryKey: ["events", "failed", "panel"],
    queryFn: () => apiFetch<{ events: EventDTO[] }>("/api/events?filter=failed&limit=10"),
    refetchInterval: 10_000,
  });
  const failures = (query.data?.events ?? []).flatMap(failuresOf).slice(0, 6);

  return (
    <section aria-labelledby="failures-heading" className="rounded-lg border border-stone-200 bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 id="failures-heading" className="font-medium">
          Recent failures
        </h2>
        <Link href="/dashboard/activity" className="text-sm text-stone-600 underline hover:text-stone-900">
          All activity
        </Link>
      </div>
      {query.isPending ? (
        <p className="mt-3 text-sm text-stone-500">Loading…</p>
      ) : query.isError ? (
        <p role="alert" className="mt-3 text-sm text-red-700">
          {query.error.message}
        </p>
      ) : failures.length === 0 ? (
        <p className="mt-3 text-sm text-stone-500">No failures. 🎉</p>
      ) : (
        <ul className="mt-3 divide-y divide-stone-100">
          {failures.map((f, i) => (
            <li key={`${f.eventId}-${i}`} className="py-2 text-sm">
              <Link href={`/dashboard/activity/${f.eventId}`} className="font-medium hover:underline">
                {f.what}
              </Link>
              <p className="mt-0.5 text-red-800">{f.reason}</p>
              <p className="mt-0.5 text-xs text-stone-500">
                {f.attempts} {f.attempts === 1 ? "attempt" : "attempts"} ·{" "}
                <time dateTime={f.at} title={formatDateTime(f.at)}>
                  {timeAgo(f.at)}
                </time>
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
