"use client";

import { useInfiniteQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { EventDTO, EventFilter } from "@/lib/activity-types";
import { apiFetch } from "@/lib/api-client";
import { formatDateTime, timeAgo } from "@/lib/format";
import { Badge, describeRunAction, eventSummary, PriorityBadge, StepBadge } from "./activity-status";

type Page = { events: EventDTO[]; nextCursor: string | null };

const FILTERS: Array<{ value: EventFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "failed", label: "Failures" },
  { value: "in_progress", label: "In progress" },
];

function eventLabel(e: EventDTO) {
  const kind =
    e.eventType === "pull_request" ? "pull request" : e.eventType === "issues" ? "issue" : e.eventType;
  return e.action ? `${kind} ${e.action}` : kind;
}

/**
 * Live activity log: refetches every 5 s (paused while the tab is hidden — TanStack
 * Query's default), so new deliveries and step results appear without a reload.
 */
export function ActivityFeed({ pageSize = 25, compact = false }: { pageSize?: number; compact?: boolean }) {
  const [filter, setFilter] = useState<EventFilter>("all");
  const query = useInfiniteQuery({
    queryKey: ["events", filter, pageSize],
    queryFn: ({ pageParam }) =>
      apiFetch<Page>(
        `/api/events?limit=${pageSize}&filter=${filter}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ""}`,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    refetchInterval: 5_000,
  });
  const events = query.data?.pages.flatMap((p) => p.events) ?? [];

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        {!compact ? (
          <div role="tablist" aria-label="Filter activity" className="flex gap-1">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                role="tab"
                aria-selected={filter === f.value}
                onClick={() => setFilter(f.value)}
                className={`rounded-md px-3 py-1 text-sm ${
                  filter === f.value ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-100"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        ) : (
          <span />
        )}
        <span className="flex items-center gap-1.5 text-xs text-stone-500" aria-live="polite">
          <span
            className={`h-2 w-2 rounded-full ${query.isError ? "bg-red-500" : "bg-emerald-500"}`}
            aria-hidden="true"
          />
          {query.isError
            ? "Live updates paused — retrying"
            : query.dataUpdatedAt
              ? `Live · updated ${timeAgo(new Date(query.dataUpdatedAt).toISOString())}`
              : "Connecting…"}
        </span>
      </div>

      {query.isPending ? (
        <p className="text-sm text-stone-500">Loading activity…</p>
      ) : query.isError && events.length === 0 ? (
        <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {query.error.message}
        </p>
      ) : events.length === 0 ? (
        <p className="rounded-md border border-dashed border-stone-300 px-4 py-8 text-center text-sm text-stone-500">
          {filter === "all"
            ? "No events yet. Open an issue or pull request in a connected repository."
            : "Nothing here right now."}
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-stone-200 bg-white">
          <table className="w-full min-w-[56rem] text-left text-sm">
            <thead className="border-b border-stone-200 bg-stone-50 text-xs text-stone-500">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">
                  Time
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Repository
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Event
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Actor
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Title
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Rule → action
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  GitHub
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Slack
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100">
              {events.map((e) => {
                const summary = eventSummary(e);
                const run = e.runs[0];
                return (
                  <tr key={e.id} className="align-top hover:bg-stone-50">
                    <td className="whitespace-nowrap px-3 py-2 text-stone-500">
                      <Link
                        href={`/dashboard/activity/${e.id}`}
                        className="hover:underline"
                        title={formatDateTime(e.receivedAt)}
                      >
                        {timeAgo(e.receivedAt)}
                      </Link>
                    </td>
                    <td className="max-w-[12rem] truncate px-3 py-2 font-mono text-xs">
                      {e.repoFullName ?? "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{eventLabel(e)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{e.senderLogin ?? "—"}</td>
                    <td className="max-w-[16rem] px-3 py-2">
                      {e.subject ? (
                        <>
                          <Link href={`/dashboard/activity/${e.id}`} className="line-clamp-2 hover:underline">
                            #{e.subject.number} {e.subject.title}
                          </Link>
                          {e.ai?.result && (
                            <span
                              className="mt-1 flex items-center gap-1.5 text-xs text-stone-500"
                              title={e.ai.result.summary}
                            >
                              <PriorityBadge priority={e.ai.result.priority} />
                              AI suggests “{e.ai.result.suggestedLabel}”
                            </span>
                          )}
                          {e.ai?.status === "failed" && (
                            <span className="mt-1 block text-xs text-red-700">AI triage failed</span>
                          )}
                        </>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>
                    <td className="max-w-[14rem] px-3 py-2">
                      {run ? (
                        <>
                          <span className="block truncate font-medium">{run.ruleName}</span>
                          <span className="block truncate text-xs text-stone-500">
                            {describeRunAction(run)}
                            {e.runs.length > 1 ? ` · +${e.runs.length - 1} more` : ""}
                          </span>
                        </>
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {run ? (
                        <StepBadge
                          status={run.githubStatus}
                          error={run.githubError}
                          attempts={run.githubAttempts}
                        />
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {run ? (
                        <StepBadge
                          status={run.slackStatus}
                          error={run.slackError}
                          attempts={run.slackAttempts}
                        />
                      ) : (
                        <span className="text-stone-400">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={summary.tone} title={summary.detail}>
                        {summary.label}
                      </Badge>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!compact && query.hasNextPage && (
        <button
          type="button"
          onClick={() => query.fetchNextPage()}
          disabled={query.isFetchingNextPage}
          className="mt-3 rounded-md border border-stone-300 px-4 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-60"
        >
          {query.isFetchingNextPage ? "Loading…" : "Load older events"}
        </button>
      )}
    </div>
  );
}
