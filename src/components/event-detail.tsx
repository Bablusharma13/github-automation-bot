"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import type { EventDetailDTO, RunDTO } from "@/lib/activity-types";
import { apiFetch } from "@/lib/api-client";
import { formatDateTime, timeAgo } from "@/lib/format";
import { Badge, describeRunAction, eventSummary, StepBadge } from "./activity-status";

function When({ iso, label }: { iso: string | null; label: string }) {
  if (!iso) return null;
  return (
    <div>
      <dt className="text-xs text-stone-500">{label}</dt>
      <dd className="text-sm">
        <time dateTime={iso}>{formatDateTime(iso)}</time>{" "}
        <span className="text-stone-500">({timeAgo(iso)})</span>
      </dd>
    </div>
  );
}

function RunCard({ run }: { run: RunDTO }) {
  const result = run.githubResult;
  return (
    <li className="rounded-lg border border-stone-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">
          {run.ruleName}
          {!run.ruleId && (
            <span className="ml-2 text-xs font-normal text-stone-500">(rule since deleted)</span>
          )}
        </p>
        <Badge tone={run.status === "succeeded" ? "green" : run.status === "failed" ? "red" : "blue"}>
          {run.status}
        </Badge>
      </div>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-stone-500">GitHub action</dt>
          <dd className="mt-1 flex flex-wrap items-center gap-2 text-sm">
            <StepBadge status={run.githubStatus} attempts={run.githubAttempts} />
            <span>{describeRunAction(run)}</span>
            {result?.commentUrl && (
              <a href={result.commentUrl} target="_blank" rel="noreferrer" className="text-xs underline">
                view comment
              </a>
            )}
          </dd>
          <dd className="mt-1 text-xs text-stone-500">
            {run.githubAttempts} {run.githubAttempts === 1 ? "attempt" : "attempts"}
          </dd>
          {run.githubError && <dd className="mt-1 text-sm text-red-800">{run.githubError}</dd>}
        </div>
        <div>
          <dt className="text-xs text-stone-500">Slack notification</dt>
          <dd className="mt-1">
            <StepBadge status={run.slackStatus} attempts={run.slackAttempts} />
          </dd>
          <dd className="mt-1 text-xs text-stone-500">
            {run.slackAttempts} {run.slackAttempts === 1 ? "attempt" : "attempts"}
          </dd>
          {run.slackError && (
            <dd
              className={`mt-1 text-sm ${run.slackStatus === "failed" ? "text-red-800" : "text-stone-600"}`}
            >
              {run.slackError}
            </dd>
          )}
        </div>
      </dl>
    </li>
  );
}

export function EventDetail({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const query = useQuery({
    queryKey: ["event", id],
    queryFn: () => apiFetch<{ event: EventDetailDTO }>(`/api/events/${id}`),
    // Poll while work is still happening so results appear as they land.
    refetchInterval: (q) => {
      const s = q.state.data?.event.status;
      return s === "received" || s === "processing" ? 3_000 : false;
    },
  });
  const retry = useMutation({
    mutationFn: () => apiFetch<{ queued: true }>(`/api/events/${id}/retry`, { method: "POST" }),
    onSuccess: async () => {
      setNotice({ kind: "ok", text: "Retry queued. Results will appear here in a few seconds." });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["event", id] }),
        queryClient.invalidateQueries({ queryKey: ["events"] }),
        queryClient.invalidateQueries({ queryKey: ["stats"] }),
      ]);
    },
    onError: (err) => setNotice({ kind: "error", text: err.message }),
  });

  if (query.isPending) return <p className="text-sm text-stone-500">Loading event…</p>;
  if (query.isError) {
    return (
      <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
        {query.error.message}
      </p>
    );
  }

  const e = query.data.event;
  const summary = eventSummary(e);
  const canRetry = e.status === "failed" || e.runs.some((r) => r.status === "failed");

  return (
    <div className="space-y-6">
      <div>
        <Link href="/dashboard/activity" className="text-sm text-stone-600 underline hover:text-stone-900">
          ← All activity
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">
          {e.subject ? (
            <a href={e.subject.url} target="_blank" rel="noreferrer" className="hover:underline">
              #{e.subject.number} {e.subject.title}
            </a>
          ) : (
            `${e.eventType}${e.action ? `.${e.action}` : ""}`
          )}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-stone-600">
          <Badge tone={summary.tone}>{summary.label}</Badge>
          {summary.detail && <span>{summary.detail}</span>}
        </div>
      </div>

      {notice && (
        <p
          role={notice.kind === "error" ? "alert" : "status"}
          className={notice.kind === "error" ? "text-sm text-red-700" : "text-sm text-emerald-800"}
        >
          {notice.text}
        </p>
      )}
      {canRetry && (
        <button
          type="button"
          onClick={() => {
            setNotice(null);
            retry.mutate();
          }}
          disabled={retry.isPending}
          className="rounded-md bg-stone-900 px-4 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-60"
        >
          {retry.isPending ? "Queuing…" : "Retry failed steps"}
        </button>
      )}

      <section className="rounded-lg border border-stone-200 bg-white p-5">
        <h2 className="font-medium">Delivery</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-3">
          <div>
            <dt className="text-xs text-stone-500">Repository</dt>
            <dd className="font-mono text-sm">{e.repoFullName ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-stone-500">Event</dt>
            <dd className="text-sm">
              {e.eventType}
              {e.action ? `.${e.action}` : ""}
            </dd>
          </div>
          <div>
            <dt className="text-xs text-stone-500">Actor · author</dt>
            <dd className="text-sm">
              {e.senderLogin ?? "—"} · {e.subject?.author ?? "—"}
            </dd>
          </div>
          <div className="sm:col-span-2">
            <dt className="text-xs text-stone-500">GitHub delivery ID</dt>
            <dd className="break-all font-mono text-xs">{e.deliveryId}</dd>
          </div>
          <div>
            <dt className="text-xs text-stone-500">Labels at delivery</dt>
            <dd className="text-sm">{e.subject?.labels.length ? e.subject.labels.join(", ") : "none"}</dd>
          </div>
          <When iso={e.receivedAt} label="Received" />
          <When iso={e.processedAt} label="Finished" />
        </dl>
        {e.bodyPreview && (
          <details className="mt-4">
            <summary className="cursor-pointer text-sm text-stone-600">Body (first 500 characters)</summary>
            <p className="mt-2 whitespace-pre-wrap rounded-md bg-stone-50 p-3 text-sm text-stone-700">
              {e.bodyPreview}
            </p>
          </details>
        )}
      </section>

      {e.job && (
        <section className="rounded-lg border border-stone-200 bg-white p-5">
          <h2 className="font-medium">Processing</h2>
          <dl className="mt-3 grid gap-3 sm:grid-cols-3">
            <div>
              <dt className="text-xs text-stone-500">Job</dt>
              <dd className="text-sm">{e.job.status}</dd>
            </div>
            <div>
              <dt className="text-xs text-stone-500">Attempts</dt>
              <dd className="text-sm">
                {e.job.attempts} of {e.job.maxAttempts}
              </dd>
            </div>
            {e.job.status === "pending" && e.job.attempts > 0 && (
              <When iso={e.job.runAt} label="Next attempt" />
            )}
            {e.job.lastError && (
              <div className="sm:col-span-3">
                <dt className="text-xs text-stone-500">Last error</dt>
                <dd className="text-sm text-red-800">{e.job.lastError}</dd>
              </div>
            )}
          </dl>
        </section>
      )}

      <section>
        <h2 className="font-medium">Matched rules</h2>
        {e.runs.length === 0 ? (
          <p className="mt-2 text-sm text-stone-500">
            {e.status === "ignored"
              ? `This delivery was ignored (${e.ignoreReason?.replaceAll("_", " ")}).`
              : e.status === "processed"
                ? "No rule matched this event."
                : "Rules have not been evaluated yet."}
          </p>
        ) : (
          <ul className="mt-2 space-y-3">
            {e.runs.map((r) => (
              <RunCard key={r.id} run={r} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
