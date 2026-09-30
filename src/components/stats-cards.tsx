"use client";

import { useQuery } from "@tanstack/react-query";
import type { StatsDTO } from "@/lib/activity-types";
import { apiFetch } from "@/lib/api-client";

const CARDS: Array<{ key: keyof StatsDTO; label: string; hint?: (s: StatsDTO) => string }> = [
  {
    key: "connectedRepositories",
    label: "Connected repositories",
    hint: (s) => `${s.enabledRules} enabled rules`,
  },
  { key: "eventsTotal", label: "Events received", hint: (s) => `${s.events24h} in the last 24 h` },
  { key: "actionsSucceeded", label: "Successful actions", hint: () => "labels and comments on GitHub" },
  {
    key: "actionsFailed",
    label: "Failed runs",
    hint: (s) => (s.retriesPending ? `${s.retriesPending} retrying` : "none retrying"),
  },
];

export function StatsCards() {
  const stats = useQuery({
    queryKey: ["stats"],
    queryFn: () => apiFetch<StatsDTO>("/api/stats"),
    refetchInterval: 10_000,
  });

  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {CARDS.map((card) => (
        <div key={card.key} className="rounded-lg border border-stone-200 bg-white p-4">
          <dt className="text-xs text-stone-500">{card.label}</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums">
            {stats.data ? stats.data[card.key] : stats.isError ? "—" : "…"}
          </dd>
          {stats.data && card.hint && (
            <dd className="mt-0.5 text-xs text-stone-500">{card.hint(stats.data)}</dd>
          )}
        </div>
      ))}
    </dl>
  );
}
