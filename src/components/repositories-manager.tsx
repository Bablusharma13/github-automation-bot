"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
// Type-only imports are erased at build time; no server code reaches the browser.
import type { ConnectableRepository, RepositoryDTO } from "@/server/repositories/service";

type Notice = { kind: "success" | "warning" | "error"; text: string } | null;

function ErrorBox({ error }: { error: unknown }) {
  const reauth = error instanceof ApiError && error.code === "github_reauth_required";
  const message = error instanceof Error ? error.message : "Something went wrong.";
  return (
    <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      {message}{" "}
      {reauth && (
        <a href="/api/auth/github" className="font-medium underline">
          Sign in again
        </a>
      )}
    </div>
  );
}

function NoticeBar({ notice, onClose }: { notice: Notice; onClose: () => void }) {
  if (!notice) return null;
  const styles = {
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    warning: "border-amber-200 bg-amber-50 text-amber-900",
    error: "border-red-200 bg-red-50 text-red-800",
  }[notice.kind];
  return (
    <div
      role="status"
      className={`flex items-start justify-between gap-4 rounded-md border px-4 py-3 text-sm ${styles}`}
    >
      <span>{notice.text}</span>
      <button type="button" onClick={onClose} className="text-xs underline" aria-label="Dismiss message">
        Dismiss
      </button>
    </div>
  );
}

export function RepositoriesManager() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState<Notice>(null);
  const [filter, setFilter] = useState("");
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const connected = useQuery({
    queryKey: ["repositories"],
    queryFn: () => apiFetch<{ repositories: RepositoryDTO[] }>("/api/repositories"),
  });
  const available = useQuery({
    queryKey: ["github-repositories"],
    queryFn: () =>
      apiFetch<{ repositories: ConnectableRepository[]; webhookUrl: string }>("/api/github/repositories"),
    staleTime: 60_000,
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["repositories"] }),
      queryClient.invalidateQueries({ queryKey: ["github-repositories"] }),
    ]);

  const connect = useMutation({
    mutationFn: (fullName: string) =>
      apiFetch<{ repository: RepositoryDTO; created: boolean }>("/api/repositories", {
        method: "POST",
        body: { fullName },
      }),
    onSuccess: async (data) => {
      setNotice({
        kind: "success",
        text: data.created
          ? `Connected ${data.repository.fullName}. The webhook is installed.`
          : `${data.repository.fullName} was already connected.`,
      });
      await invalidate();
    },
    onError: (err) => setNotice({ kind: "error", text: err.message }),
  });

  const disconnect = useMutation({
    mutationFn: (repo: RepositoryDTO) =>
      apiFetch<{ webhookRemoved: boolean; warning?: string }>(`/api/repositories/${repo.id}`, {
        method: "DELETE",
      }).then((result) => ({ result, repo })),
    onSuccess: async ({ result, repo }) => {
      setConfirmingId(null);
      setNotice(
        result.webhookRemoved
          ? { kind: "success", text: `Disconnected ${repo.fullName} and removed its webhook.` }
          : { kind: "warning", text: result.warning ?? `Disconnected ${repo.fullName}.` },
      );
      await invalidate();
    },
    onError: (err) => {
      setConfirmingId(null);
      setNotice({ kind: "error", text: err.message });
    },
  });

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = available.data?.repositories ?? [];
    return q ? list.filter((r) => r.fullName.toLowerCase().includes(q)) : list;
  }, [available.data, filter]);

  const busyName = connect.isPending ? connect.variables : null;

  return (
    <div className="mt-8 space-y-10">
      <NoticeBar notice={notice} onClose={() => setNotice(null)} />

      <section aria-labelledby="connected-heading">
        <h2 id="connected-heading" className="font-medium">
          Connected
        </h2>
        <div className="mt-3">
          {connected.isPending ? (
            <p className="text-sm text-stone-500">Loading connected repositories…</p>
          ) : connected.isError ? (
            <ErrorBox error={connected.error} />
          ) : connected.data.repositories.length === 0 ? (
            <p className="rounded-md border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500">
              No repositories connected yet. Pick one below.
            </p>
          ) : (
            <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
              {connected.data.repositories.map((repo) => (
                <li key={repo.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <a
                      href={repo.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-sm hover:underline"
                    >
                      {repo.fullName}
                    </a>
                    <p className="mt-0.5 text-xs text-stone-500">
                      {repo.webhookInstalled ? "Webhook installed" : "Webhook missing"} · connected{" "}
                      {new Date(repo.connectedAt).toLocaleString()}
                    </p>
                  </div>
                  {confirmingId === repo.id ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-stone-600">Remove webhook and disconnect?</span>
                      <button
                        type="button"
                        onClick={() => disconnect.mutate(repo)}
                        disabled={disconnect.isPending}
                        className="rounded-md bg-red-700 px-3 py-1.5 text-sm text-white hover:bg-red-800 disabled:opacity-60"
                      >
                        {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmingId(null)}
                        disabled={disconnect.isPending}
                        className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setConfirmingId(repo.id)}
                      className="rounded-md border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100"
                    >
                      Disconnect
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section aria-labelledby="available-heading">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="available-heading" className="font-medium">
              Connect a repository
            </h2>
            <p className="mt-1 text-xs text-stone-500">Public repositories where you are an admin.</p>
          </div>
          <label className="flex flex-col text-xs text-stone-600">
            Filter
            <input
              type="search"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="owner/name"
              className="mt-1 w-64 rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 focus:border-stone-500 focus:outline-none"
            />
          </label>
        </div>
        <div className="mt-3">
          {available.isPending ? (
            <p className="text-sm text-stone-500">Loading your repositories from GitHub…</p>
          ) : available.isError ? (
            <ErrorBox error={available.error} />
          ) : filtered.length === 0 ? (
            <p className="rounded-md border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500">
              {filter
                ? "No repositories match that filter."
                : "No public repositories where you are an admin. Create one on GitHub, then refresh."}
            </p>
          ) : (
            <ul className="divide-y divide-stone-100 rounded-lg border border-stone-200 bg-white">
              {filtered.map((repo) => (
                <li
                  key={repo.githubRepoId}
                  className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                >
                  <div className="min-w-0">
                    <a
                      href={repo.htmlUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-sm hover:underline"
                    >
                      {repo.fullName}
                    </a>
                    {repo.description && (
                      <p className="mt-0.5 truncate text-xs text-stone-500">{repo.description}</p>
                    )}
                  </div>
                  {repo.connected ? (
                    <span className="rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-800">
                      Connected
                    </span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => connect.mutate(repo.fullName)}
                      disabled={connect.isPending}
                      className="rounded-md bg-stone-900 px-3 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-60"
                    >
                      {busyName === repo.fullName ? "Connecting…" : "Connect"}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
          {available.data && (
            <p className="mt-3 text-xs text-stone-500">
              Webhooks are delivered to <span className="font-mono">{available.data.webhookUrl}</span>
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
