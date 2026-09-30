"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { ApiError, apiFetch } from "@/lib/api-client";
import {
  ACTION_TYPE_LABELS,
  EVENT_TYPE_LABELS,
  KEYWORD_SCOPE_LABELS,
  RULE_EVENT_ACTIONS,
  RULE_LIMITS,
  type RuleActionType,
  type RuleDTO,
  type RuleEventAction,
  type RuleEventType,
  type RuleKeywordScope,
} from "@/lib/rules-config";
// Type-only import: erased at build time, no server code reaches the browser.
import type { RepositoryDTO } from "@/server/repositories/service";

type FormState = {
  repositoryId: string;
  name: string;
  eventType: RuleEventType;
  eventActions: RuleEventAction[];
  keywordsText: string;
  keywordScope: RuleKeywordScope;
  actionType: RuleActionType;
  actionValue: string;
  notifySlack: boolean;
  aiTriage: boolean;
};

const emptyForm = (repositoryId = ""): FormState => ({
  repositoryId,
  name: "Bug issue automation",
  eventType: "issues",
  eventActions: ["opened"],
  keywordsText: "bug",
  keywordScope: "title",
  actionType: "add_label",
  actionValue: "bug",
  notifySlack: true,
  aiTriage: false,
});

const formFromRule = (r: RuleDTO): FormState => ({
  repositoryId: r.repositoryId,
  name: r.name,
  eventType: r.eventType,
  eventActions: r.eventActions,
  keywordsText: r.keywords.join(", "),
  keywordScope: r.keywordScope,
  actionType: r.actionType,
  actionValue: r.actionValue,
  notifySlack: r.notifySlack,
  aiTriage: r.aiTriage,
});

const keywordsFromText = (text: string) =>
  text
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);

function describeTrigger(
  r: Pick<RuleDTO, "eventType" | "eventActions" | "keywords" | "keywordScope" | "repositoryFullName">,
) {
  const subject = r.eventType === "issues" ? "an issue" : "a pull request";
  const actions = r.eventActions.join(" or ");
  const keywords = r.keywords.map((k) => `“${k}”`).join(" or ");
  // Name the repository in the sentence: with several repos connected, a rule on the
  // wrong one is otherwise easy to miss.
  const where = `in ${r.repositoryFullName}`;
  return keywords
    ? `When ${subject} is ${actions} ${where} and its ${KEYWORD_SCOPE_LABELS[r.keywordScope]} contains ${keywords}`
    : `When ${subject} is ${actions} ${where}`;
}

function describeAction(r: Pick<RuleDTO, "actionType" | "actionValue" | "notifySlack" | "aiTriage">) {
  const action =
    r.actionType === "add_label"
      ? `add the label “${r.actionValue}”`
      : `post a comment (${r.actionValue.length} characters)`;
  const ai = r.aiTriage ? ", ask AI for a triage suggestion" : "";
  return `${action}${ai}${r.notifySlack ? ", then notify Slack" : ""}`;
}

function ErrorText({ error }: { error: unknown }) {
  if (!error) return null;
  const reauth = error instanceof ApiError && error.code === "github_reauth_required";
  return (
    <p role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
      {error instanceof Error ? error.message : "Something went wrong."}{" "}
      {reauth && (
        <a href="/api/auth/github" className="font-medium underline">
          Sign in again
        </a>
      )}
    </p>
  );
}

function RuleForm({
  initial,
  repositories,
  mode,
  aiAvailable,
  pending,
  error,
  onSubmit,
  onCancel,
}: {
  initial: FormState;
  repositories: RepositoryDTO[];
  mode: "create" | "edit";
  aiAvailable: boolean;
  pending: boolean;
  error: unknown;
  onSubmit: (form: FormState) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<FormState>(initial);
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((f) => ({ ...f, [key]: value }));
  const toggleAction = (a: RuleEventAction) =>
    set(
      "eventActions",
      form.eventActions.includes(a) ? form.eventActions.filter((x) => x !== a) : [...form.eventActions, a],
    );
  const inputClass =
    "mt-1 w-full rounded-md border border-stone-300 bg-white px-3 py-1.5 text-sm text-stone-900 focus:border-stone-500 focus:outline-none";
  const labelClass = "block text-xs font-medium text-stone-600";

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(form);
      }}
      className="space-y-4 rounded-lg border border-stone-200 bg-white p-5"
    >
      <h3 className="font-medium">{mode === "create" ? "New rule" : "Edit rule"}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={labelClass}>
          Repository
          <select
            value={form.repositoryId}
            onChange={(e) => set("repositoryId", e.target.value)}
            disabled={mode === "edit"}
            required
            className={inputClass}
          >
            <option value="" disabled>
              Choose a repository
            </option>
            {repositories.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          Name
          <input
            value={form.name}
            onChange={(e) => set("name", e.target.value)}
            maxLength={RULE_LIMITS.nameMax}
            required
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Event
          <select
            value={form.eventType}
            onChange={(e) => set("eventType", e.target.value as RuleEventType)}
            className={inputClass}
          >
            {(Object.keys(EVENT_TYPE_LABELS) as RuleEventType[]).map((t) => (
              <option key={t} value={t}>
                {EVENT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <fieldset>
          <legend className={labelClass}>When it is</legend>
          <div className="mt-2 flex gap-4">
            {RULE_EVENT_ACTIONS.map((a) => (
              <label key={a} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={form.eventActions.includes(a)}
                  onChange={() => toggleAction(a)}
                />
                {a}
              </label>
            ))}
          </div>
        </fieldset>
        <label className={labelClass}>
          Keywords (comma-separated; any match — leave empty to match everything)
          <input
            value={form.keywordsText}
            onChange={(e) => set("keywordsText", e.target.value)}
            placeholder="bug, crash"
            className={inputClass}
          />
        </label>
        <label className={labelClass}>
          Look for keywords in
          <select
            value={form.keywordScope}
            onChange={(e) => set("keywordScope", e.target.value as RuleKeywordScope)}
            className={inputClass}
          >
            <option value="title">Title</option>
            <option value="title_and_body">Title or body</option>
          </select>
        </label>
        <label className={labelClass}>
          Action
          <select
            value={form.actionType}
            onChange={(e) => set("actionType", e.target.value as RuleActionType)}
            className={inputClass}
          >
            {(Object.keys(ACTION_TYPE_LABELS) as RuleActionType[]).map((t) => (
              <option key={t} value={t}>
                {ACTION_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <label className={labelClass}>
          {form.actionType === "add_label" ? "Label name (must exist in the repository)" : "Comment text"}
          {form.actionType === "add_label" ? (
            <input
              value={form.actionValue}
              onChange={(e) => set("actionValue", e.target.value)}
              maxLength={RULE_LIMITS.labelMax}
              required
              className={inputClass}
            />
          ) : (
            <textarea
              value={form.actionValue}
              onChange={(e) => set("actionValue", e.target.value)}
              maxLength={RULE_LIMITS.commentMax}
              rows={3}
              required
              className={inputClass}
            />
          )}
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.notifySlack}
          onChange={(e) => set("notifySlack", e.target.checked)}
        />
        Send a Slack notification with the outcome
      </label>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.aiTriage}
          onChange={(e) => set("aiTriage", e.target.checked)}
          className="mt-1"
        />
        <span>
          Add an AI triage suggestion (summary, suggested label, priority) to the activity log and Slack
          <span className="block text-xs text-stone-500">
            Sends the issue or pull request title and body to Google Gemini. Suggestions only — the bot never
            acts on them.
            {!aiAvailable && " AI is not configured on this server, so the step will be recorded as skipped."}
          </span>
        </span>
      </label>
      <ErrorText error={error} />
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending}
          className="rounded-md bg-stone-900 px-4 py-1.5 text-sm text-white hover:bg-stone-700 disabled:opacity-60"
        >
          {pending ? "Saving…" : mode === "create" ? "Create rule" : "Save changes"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={pending}
          className="rounded-md border border-stone-300 px-4 py-1.5 text-sm hover:bg-stone-100"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

export function RulesManager() {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const rulesQuery = useQuery({
    queryKey: ["rules"],
    queryFn: () => apiFetch<{ rules: RuleDTO[]; aiAvailable: boolean }>("/api/rules"),
  });
  const reposQuery = useQuery({
    queryKey: ["repositories"],
    queryFn: () => apiFetch<{ repositories: RepositoryDTO[] }>("/api/repositories"),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ["rules"] });

  const toBody = (f: FormState) => ({
    name: f.name,
    eventType: f.eventType,
    eventActions: f.eventActions,
    keywords: keywordsFromText(f.keywordsText),
    keywordScope: f.keywordScope,
    actionType: f.actionType,
    actionValue: f.actionValue,
    notifySlack: f.notifySlack,
    aiTriage: f.aiTriage,
  });

  const create = useMutation({
    mutationFn: (f: FormState) =>
      apiFetch<{ rule: RuleDTO }>("/api/rules", {
        method: "POST",
        body: { repositoryId: f.repositoryId, ...toBody(f) },
      }),
    onSuccess: async ({ rule }) => {
      setEditing(null);
      setNotice(`Created “${rule.name}”.`);
      await refresh();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) =>
      apiFetch<{ rule: RuleDTO }>(`/api/rules/${id}`, { method: "PATCH", body }),
    onSuccess: async ({ rule }, vars) => {
      if (!("enabled" in vars.body && Object.keys(vars.body).length === 1)) {
        setEditing(null);
        setNotice(`Saved “${rule.name}”.`);
      }
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: (rule: RuleDTO) =>
      apiFetch<{ deleted: true }>(`/api/rules/${rule.id}`, { method: "DELETE" }).then(() => rule),
    onSuccess: async (rule) => {
      setConfirmingDelete(null);
      setNotice(`Deleted “${rule.name}”. Past runs are kept in the activity history.`);
      await refresh();
    },
  });

  const connected = [...(reposQuery.data?.repositories ?? [])].sort((a, b) =>
    a.fullName.localeCompare(b.fullName),
  );

  if (rulesQuery.isPending || reposQuery.isPending) {
    return <p className="mt-8 text-sm text-stone-500">Loading rules…</p>;
  }
  if (rulesQuery.isError)
    return (
      <div className="mt-8">
        <ErrorText error={rulesQuery.error} />
      </div>
    );
  if (reposQuery.isError)
    return (
      <div className="mt-8">
        <ErrorText error={reposQuery.error} />
      </div>
    );

  const rules = rulesQuery.data.rules;
  const aiAvailable = rulesQuery.data.aiAvailable;

  return (
    <div className="mt-8 space-y-6">
      {notice && (
        <div
          role="status"
          className="flex items-start justify-between gap-4 rounded-md border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-900"
        >
          <span>{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="text-xs underline">
            Dismiss
          </button>
        </div>
      )}

      {connected.length === 0 ? (
        <p className="rounded-md border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500">
          Rules run on connected repositories.{" "}
          <Link href="/dashboard/repositories" className="underline">
            Connect a repository
          </Link>{" "}
          first.
        </p>
      ) : editing === "new" ? (
        <RuleForm
          // Pre-select only when there is exactly one repository. With several, the user
          // must choose explicitly (a silently pre-selected repo caused a rule to be
          // created on the wrong repository in real use).
          initial={emptyForm(connected.length === 1 ? connected[0]!.id : "")}
          repositories={connected}
          mode="create"
          aiAvailable={aiAvailable}
          pending={create.isPending}
          error={create.error}
          onSubmit={(f) => create.mutate(f)}
          onCancel={() => {
            setEditing(null);
            create.reset();
          }}
        />
      ) : (
        <button
          type="button"
          onClick={() => {
            setEditing("new");
            setNotice(null);
          }}
          className="rounded-md bg-stone-900 px-4 py-2 text-sm text-white hover:bg-stone-700"
        >
          New rule
        </button>
      )}

      {rules.length === 0 ? (
        connected.length > 0 && (
          <p className="rounded-md border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500">
            No rules yet. Create one to start automating.
          </p>
        )
      ) : (
        <ul className="space-y-3">
          {rules.map((rule) =>
            editing === rule.id ? (
              <li key={rule.id}>
                <RuleForm
                  initial={formFromRule(rule)}
                  repositories={[
                    { id: rule.repositoryId, fullName: rule.repositoryFullName } as RepositoryDTO,
                  ]}
                  mode="edit"
                  aiAvailable={aiAvailable}
                  pending={update.isPending}
                  error={update.error}
                  onSubmit={(f) => update.mutate({ id: rule.id, body: toBody(f) })}
                  onCancel={() => {
                    setEditing(null);
                    update.reset();
                  }}
                />
              </li>
            ) : (
              <li
                key={rule.id}
                className={`rounded-lg border bg-white p-4 ${rule.enabled ? "border-stone-200" : "border-dashed border-stone-300 opacity-75"}`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">
                      {rule.name}{" "}
                      <span className="ml-1 font-mono text-xs font-normal text-stone-500">
                        {rule.repositoryFullName}
                      </span>
                    </p>
                    <p className="mt-1 text-sm text-stone-700">{describeTrigger(rule)},</p>
                    <p className="text-sm text-stone-700">{describeAction(rule)}.</p>
                    {!rule.repositoryActive && (
                      <p className="mt-1 text-xs text-amber-700">
                        Repository disconnected — this rule will not run until it is connected again.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 text-sm">
                      <input
                        type="checkbox"
                        checked={rule.enabled}
                        disabled={update.isPending}
                        onChange={(e) => update.mutate({ id: rule.id, body: { enabled: e.target.checked } })}
                        aria-label={`${rule.enabled ? "Disable" : "Enable"} ${rule.name}`}
                      />
                      {rule.enabled ? "Enabled" : "Disabled"}
                    </label>
                    <button
                      type="button"
                      onClick={() => {
                        setEditing(rule.id);
                        setNotice(null);
                      }}
                      className="rounded-md border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
                    >
                      Edit
                    </button>
                    {confirmingDelete === rule.id ? (
                      <>
                        <button
                          type="button"
                          onClick={() => remove.mutate(rule)}
                          disabled={remove.isPending}
                          className="rounded-md bg-red-700 px-3 py-1 text-sm text-white hover:bg-red-800 disabled:opacity-60"
                        >
                          {remove.isPending ? "Deleting…" : "Confirm delete"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmingDelete(null)}
                          className="rounded-md border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmingDelete(rule.id)}
                        className="rounded-md border border-stone-300 px-3 py-1 text-sm text-red-700 hover:bg-red-50"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ),
          )}
        </ul>
      )}
      <ErrorText error={update.error && editing === null ? update.error : remove.error} />
    </div>
  );
}
