"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "@/lib/api-client";
import { isSlackWebhookUrl } from "@/lib/slack-url";

type SlackStatus = { source: "user" | "default" | "none"; defaultAvailable: boolean; problem: string | null };

const SOURCE_TEXT: Record<SlackStatus["source"], string> = {
  user: "Notifications go to your own Slack webhook.",
  default: "Notifications go to this deployment's default Slack channel.",
  none: "Slack notifications are off: no webhook is configured.",
};

export function SlackSettings() {
  const queryClient = useQueryClient();
  const [url, setUrl] = useState("");
  const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const status = useQuery({
    queryKey: ["slack-settings"],
    queryFn: () => apiFetch<SlackStatus>("/api/settings/slack"),
  });
  const onDone = (data: SlackStatus, text: string) => {
    queryClient.setQueryData(["slack-settings"], data);
    setMessage({ kind: "ok", text });
  };
  const fail = (err: Error) => setMessage({ kind: "error", text: err.message });

  const save = useMutation({
    mutationFn: (webhookUrl: string) =>
      apiFetch<SlackStatus>("/api/settings/slack", { method: "PUT", body: { webhookUrl } }),
    onSuccess: (data) => {
      setUrl("");
      onDone(data, "Saved. Send a test notification to check it.");
    },
    onError: fail,
  });
  const clear = useMutation({
    mutationFn: () => apiFetch<SlackStatus>("/api/settings/slack", { method: "DELETE" }),
    onSuccess: (data) => onDone(data, "Removed your webhook."),
    onError: fail,
  });
  const test = useMutation({
    mutationFn: () => apiFetch<{ ok: true }>("/api/settings/slack/test", { method: "POST" }),
    onSuccess: () => setMessage({ kind: "ok", text: "Test notification sent — check the Slack channel." }),
    onError: fail,
  });

  const valid = url.trim() === "" || isSlackWebhookUrl(url.trim());
  const busy = save.isPending || clear.isPending || test.isPending;

  return (
    <section className="mt-8 rounded-lg border border-stone-200 bg-white p-5" aria-labelledby="slack-heading">
      <h2 id="slack-heading" className="font-medium">
        Slack notifications
      </h2>
      {status.isPending ? (
        <p className="mt-2 text-sm text-stone-500">Loading…</p>
      ) : status.isError ? (
        <p role="alert" className="mt-2 text-sm text-red-700">
          {status.error.message}
        </p>
      ) : (
        <>
          <p className="mt-2 text-sm text-stone-700">{SOURCE_TEXT[status.data.source]}</p>
          {status.data.problem && <p className="mt-1 text-sm text-amber-700">{status.data.problem}</p>}

          <form
            className="mt-4 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              setMessage(null);
              save.mutate(url.trim());
            }}
          >
            <label className="block text-xs font-medium text-stone-600">
              {status.data.source === "user"
                ? "Replace your Incoming Webhook URL"
                : "Your Incoming Webhook URL"}
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://hooks.slack.com/services/…"
                className="mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 font-mono text-sm focus:border-stone-500 focus:outline-none"
              />
            </label>
            {!valid && (
              <p className="text-xs text-red-700">
                Must be a Slack Incoming Webhook URL (https://hooks.slack.com/services/…).
              </p>
            )}
            <p className="text-xs text-stone-500">
              The URL contains a secret. It is stored encrypted and never shown again.
            </p>
            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="submit"
                disabled={busy || !url.trim() || !valid}
                className="rounded-md bg-stone-900 px-4 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-50"
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setMessage(null);
                  test.mutate();
                }}
                disabled={busy || status.data.source === "none"}
                className="rounded-md border border-stone-300 px-4 py-1.5 text-sm hover:bg-stone-100 disabled:opacity-50"
              >
                {test.isPending ? "Sending…" : "Send test notification"}
              </button>
              {status.data.source === "user" && (
                <button
                  type="button"
                  onClick={() => {
                    setMessage(null);
                    clear.mutate();
                  }}
                  disabled={busy}
                  className="rounded-md border border-stone-300 px-4 py-1.5 text-sm text-red-700 hover:bg-red-50 disabled:opacity-50"
                >
                  {clear.isPending ? "Removing…" : "Remove my webhook"}
                </button>
              )}
            </div>
          </form>
          {message && (
            <p
              role={message.kind === "error" ? "alert" : "status"}
              className={`mt-3 text-sm ${message.kind === "error" ? "text-red-700" : "text-emerald-800"}`}
            >
              {message.text}
            </p>
          )}
        </>
      )}
    </section>
  );
}
