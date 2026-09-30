import type { EventDTO, RunDTO, StepStatus } from "@/lib/activity-types";
import { timeAgo } from "@/lib/format";

type Tone = "green" | "red" | "amber" | "blue" | "gray";

const TONES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-800 ring-emerald-200",
  red: "bg-red-50 text-red-800 ring-red-200",
  amber: "bg-amber-50 text-amber-900 ring-amber-200",
  blue: "bg-sky-50 text-sky-800 ring-sky-200",
  gray: "bg-stone-100 text-stone-600 ring-stone-200",
};

export function Badge({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** One-line summary of where an event stands, including retries and "no rule matched". */
export function eventSummary(e: EventDTO): { tone: Tone; label: string; detail?: string } {
  if (e.status === "ignored") {
    return { tone: "gray", label: "Ignored", detail: e.ignoreReason?.replaceAll("_", " ") };
  }
  if (e.status === "failed") return { tone: "red", label: "Failed", detail: e.errorMessage ?? undefined };
  if (e.status === "received") return { tone: "blue", label: "Queued" };
  if (e.status === "processing") {
    if (e.job?.status === "pending" && e.job.attempts > 0) {
      return {
        tone: "amber",
        label: `Retrying (${e.job.attempts}/${e.job.maxAttempts})`,
        detail: `next attempt ${timeAgo(e.job.runAt)}${e.job.lastError ? ` — ${e.job.lastError}` : ""}`,
      };
    }
    return { tone: "blue", label: "Processing" };
  }
  if (e.runs.length === 0) return { tone: "gray", label: "No rule matched" };
  if (e.runs.some((r) => r.status === "failed")) return { tone: "red", label: "Completed with failures" };
  return { tone: "green", label: "Succeeded" };
}

const STEP: Record<StepStatus, { tone: Tone; label: string }> = {
  succeeded: { tone: "green", label: "Done" },
  failed: { tone: "red", label: "Failed" },
  pending: { tone: "blue", label: "Pending" },
  skipped: { tone: "gray", label: "Skipped" },
};

export function StepBadge({
  status,
  error,
  attempts,
}: {
  status: StepStatus;
  error?: string | null;
  attempts?: number;
}) {
  const s = STEP[status];
  return (
    <Badge tone={s.tone} title={error ?? undefined}>
      {s.label}
      {attempts && attempts > 1 ? ` · ${attempts} tries` : ""}
    </Badge>
  );
}

export function describeRunAction(r: RunDTO): string {
  if (r.actionType === "add_label") {
    if (r.githubStatus === "succeeded") {
      return r.githubResult?.alreadyApplied
        ? `Label “${r.githubResult.labelName ?? r.actionValue}” already present`
        : `Added label “${r.githubResult?.labelName ?? r.actionValue}”`;
    }
    return `Add label “${r.actionValue}”`;
  }
  if (r.githubStatus === "succeeded")
    return r.githubResult?.alreadyApplied ? "Comment already posted" : "Posted comment";
  return "Post comment";
}
