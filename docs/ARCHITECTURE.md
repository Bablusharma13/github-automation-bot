# Architecture

This document describes the architecture of the Event-Driven GitHub Automation Bot and
the reasoning behind each choice. It is kept in sync with the code; if they disagree,
the code wins and this file should be fixed.

## Goals and constraints

- Real end-to-end flow: GitHub OAuth → connect repo → webhook → rule → GitHub write-back
  → Slack → dashboard.
- Free infrastructure only, no credit card.
- GitHub requires a 2xx response to a webhook delivery within **10 seconds**, and does not
  automatically redeliver failed deliveries. The receiver must therefore be always
  reachable and fast, and must never lose an event it has acknowledged.
- Reliability (no silent loss, bounded retries, idempotent side effects) and security are
  first-class requirements.

## Infrastructure choices (verified 2026-09-29)

| Concern         | Choice                                  | Why                                                                                                                                                   |
| --------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web app + API   | Next.js (App Router) on Vercel Hobby    | Free, no card. Functions run up to 300s. Always reachable (no spin-down), so GitHub's 10s webhook timeout is safe.                                    |
| Database        | Neon Postgres, Free plan                | Free, no card, 0.5 GB/project, scale-to-zero after 5 min; Neon documents resume "within a few hundred milliseconds", well inside GitHub's 10s budget. |
| Background work | Postgres job table (outbox)             | Durable in the same transaction as the event. No extra service. See "Reliable processing".                                                            |
| Retry trigger   | `after()` + sweeper endpoint            | Vercel Hobby cron is limited to once/day (±59 min), so a GitHub Actions scheduled workflow (≥5 min interval) calls the sweeper.                       |
| Notifications   | Slack Incoming Webhook                  | Free, a single HTTPS POST, no bot token needed.                                                                                                       |
| AI (stretch)    | Google Gemini API (AI Studio free tier) | No card required for the free tier. Optional; core automation never depends on it.                                                                    |

Rejected alternatives:

- **Render free web service**: spins down after 15 minutes idle and takes about a minute
  to start again, which exceeds GitHub's 10s webhook timeout. Background workers are not
  a free service type.
- **BullMQ + Redis (e.g. Upstash free)**: BullMQ needs a long-running worker process. No
  free, no-card host provides an always-on process, and BullMQ's polling would also burn
  a metered free Redis command quota.
- **Vercel Queues**: included on Hobby, but in public beta at the time of writing. A
  Postgres job table gives the same guarantees we need, is testable locally without a
  Vercel account, and keeps job state queryable for the dashboard.

## Diagram

```
 Browser (evaluator)
   │  HTTPS
   ▼
 ┌──────────────────────────── Next.js on Vercel ─────────────────────────────┐
 │                                                                            │
 │  Pages (React, TanStack Query polling)                                     │
 │    /login  /dashboard  /dashboard/repositories  /dashboard/rules  ...      │
 │                                                                            │
 │  Route handlers (/api/*)                                                   │
 │    auth ──► GitHub OAuth (state + PKCE) ──► session cookie (HttpOnly)      │
 │    repositories ──► GitHub REST: list repos, create/delete repo webhook    │
 │    rules / events / runs / settings (all scoped to session user)           │
 │                                                                            │
 │    POST /api/webhooks/github                                               │
 │      1. read raw body                                                      │
 │      2. verify X-Hub-Signature-256 (HMAC-SHA256, timing-safe)              │
 │      3. validate headers + payload shape                                   │
 │      4. ONE transaction:                                                   │
 │           INSERT webhook_events ... ON CONFLICT (delivery_id) DO NOTHING   │
 │           INSERT jobs (only if the event row was new)                      │
 │      5. respond 202 (or 200 "duplicate")                                   │
 │      6. after(): drain due jobs                                            │
 │                                                                            │
 │    GET /api/cron/worker  (Bearer CRON_SECRET) ──► drain due jobs           │
 │                                                                            │
 │  Worker (library code, invoked by after() / cron / manual retry)          │
 │    claim jobs: FOR UPDATE SKIP LOCKED + lease (locked_until)               │
 │      ├─ Rule engine: match event against enabled rules for the repo        │
 │      ├─ automation_runs row per (event, rule) — UNIQUE, idempotent         │
 │      ├─ GitHub step: add label / post comment (check-before-write)         │
 │      ├─ AI step (optional, non-blocking)                                   │
 │      └─ Slack step: incoming webhook, status recorded                      │
 │    failure ─► retry with exponential backoff ─► dead after max attempts    │
 └────────────────────────────────────────────────────────────────────────────┘
          │                         │                        │
          ▼                         ▼                        ▼
   Neon Postgres              GitHub REST API          Slack Incoming Webhook
   (users, sessions,          (labels, comments,
    repositories, rules,       repo webhooks)
    webhook_events, jobs,
    automation_runs)

 GitHub ──(issues / pull_request webhook)──► POST /api/webhooks/github
 GitHub Actions schedule (every ~5 min) ──► GET /api/cron/worker
 Worker ──(optional AI triage, x-goog-api-key)──► Gemini API generateContent
```

## Components

### Frontend

Next.js App Router pages with React Server Components for the shell and client
components for interactive parts. TanStack Query polls the activity endpoints every few
seconds for the live log. No secrets or tokens are ever sent to the browser; the browser
only holds an opaque session cookie.

### Backend

Next.js Route Handlers (`src/app/api/**/route.ts`) on the Node.js runtime. Business logic
lives in `src/server/**` and is framework-agnostic so it can be unit tested without
Next.js.

### Database

PostgreSQL via Drizzle ORM over `node-postgres`. Schema and migrations are managed with
drizzle-kit. Tables:

- `users` — GitHub identity, encrypted OAuth token.
- `sessions` — SHA-256 hash of the session token (the raw token only lives in the cookie).
- `repositories` — connected repos, owning user, GitHub webhook id, active flag.
  `github_repository_id` is unique: a GitHub repo can be connected by one user at a time.
- `rules` — per-repository automation rules (event, action filter, keywords, action, Slack toggle).
- `webhook_events` — every accepted delivery. `delivery_id` is **UNIQUE**.
- `jobs` — transactional outbox / work queue (status, attempts, run_at, locked_until, last_error).
- `automation_runs` — one row per (event, rule) match. **UNIQUE(webhook_event_id, rule_id)**.
  Holds GitHub step status/attempts/result and Slack step status/attempts/result.
- `user_settings` — optional per-user Slack webhook URL (encrypted).
- `rate_limits` — fixed-window counters for auth and API endpoints.

### Authentication

GitHub OAuth App, authorization-code flow:

1. `GET /api/auth/github` (rate limited per IP) generates `state` and a PKCE
   `code_verifier`, stores both in one HttpOnly cookie (`SameSite=Lax`,
   `Path=/api/auth/github`, 10 min — GitHub codes expire after 10 minutes), redirects to
   `https://github.com/login/oauth/authorize` with `code_challenge` (S256).
2. `GET /api/auth/github/callback` (rate limited) handles GitHub-reported errors
   (`access_denied`, ...), checks `state` against the cookie (timing-safe), exchanges the
   code with the `code_verifier` server-side, fetches `/user` (and the primary verified
   email if the profile email is private), upserts the user, stores the access token
   encrypted (AES-256-GCM), invalidates the browser's previous session, creates a new
   session, clears the OAuth cookie, and redirects to `/dashboard`. Every failure
   redirects to `/login?error=<code>` with a fixed set of codes (no input is reflected).
   The token endpoint reports errors such as `bad_verification_code` in the JSON body, so
   the body is schema-validated instead of trusting the HTTP status.
3. `POST /api/auth/logout` (same-origin `Origin` required) deletes the session row and
   clears the cookie.
4. `GET /api/auth/me` returns the session user DTO
   (`id, githubLogin, name, email, avatarUrl`) or 401.

Sessions: 32 random bytes in the cookie; only the SHA-256 is stored, so a database leak
does not yield usable cookies. Fixed 7-day expiry. Cookie: `HttpOnly`, `SameSite=Lax`,
`Path=/`; when `APP_URL` is HTTPS (enforced in production) it is `Secure` and named
`__Host-session`, which pins it to this exact origin.

GitHub tokens: new OAuth apps default to "Expire user access tokens" (access token 8h,
refresh token 6 months, rotated on every use). Both tokens and their expiry times are
stored encrypted. Background work calls `getUserAccessToken()`, which refreshes a token
within 5 minutes of expiry. Because a used refresh token (and the old access token) stop
working immediately, the refresh runs under `SELECT ... FOR UPDATE` on the user row and
re-checks expiry after acquiring the lock, so concurrent workers produce exactly one
refresh. `bad_refresh_token` or an expired refresh token sets
`users.github_reauth_required_at`; automation for that user then fails fast with a clear
"sign in again" error instead of retrying. Network/5xx failures leave the stored tokens
untouched and are retryable. Signing in again clears the flag. Known edge: if GitHub
rotates the tokens but the database commit then fails, the new refresh token is lost and
the user must sign in again.

Auth checks run in pages (`requireUser()`) and in each API route — not in layouts, which
do not re-render on client navigation. Mutating API requests additionally require a
same-origin `Origin` header.

Requested scopes: `read:user user:email public_repo`. `public_repo` is the least privilege
that allows creating repository webhooks and writing labels/comments on **public**
repositories. Private repositories would need the much broader `repo` scope; a GitHub App
with fine-grained permissions is the better path for that (see README "Future improvements").

### Repository connection

API: `GET /api/github/repositories` (connectable repos, live from GitHub),
`GET /api/repositories` (connected), `POST /api/repositories { fullName }`,
`GET|DELETE /api/repositories/:id`. All go through `withUser()` (same-origin check for
mutations, session → 401, per-user mutation rate limit → 429, central error mapping), and
every query filters by the session user's id. Another user's repository id returns the
same 404 as a non-existent one.

The connectable list comes from `GET /user/repos?visibility=public` (up to 3 pages of
100), filtered to public, non-archived repositories the user administers (admin is
required to create a webhook). Connecting a repo:

1. Look the repository up on GitHub with the user's token — the client only sends
   `owner/name`, and nothing it claims is trusted. Reject private (outside our
   `public_repo` scope), archived (read-only) and non-admin repositories.
2. If another account has an active connection → 409. If this user already has it
   connected with a webhook → return it (idempotent, no second hook).
3. Create the webhook (`POST /repos/{owner}/{repo}/hooks`: JSON, events `issues` +
   `pull_request`, secret `GITHUB_WEBHOOK_SECRET`, `insecure_ssl: "0"`). If GitHub answers
   422 "Hook already exists", find the hook with our URL and PATCH it — re-sending the
   secret, because GitHub removes the secret on PATCH otherwise.
4. Upsert the repository row as active with the hook id. If that fails after we created
   the hook, the hook is deleted again (only hooks created in this request, never a
   pre-existing one). A unique-index violation from a concurrent connection → 409.

The webhook URL is `${APP_URL}/api/webhooks/github`, or `GITHUB_WEBHOOK_URL` when set.
GitHub rejects localhost URLs, so local development needs a public HTTPS tunnel.

Disconnecting deletes the webhook on GitHub (404 counts as already removed) and marks the
repo inactive; events, runs and rules are kept. If GitHub cannot be reached, the repo is
still deactivated (deliveries for inactive repos are ignored) and the response says the
webhook may need manual removal rather than claiming success. GitHub never returns the
webhook secret, and our API never exposes it.

### Webhook flow

`POST /api/webhooks/github` → `ingestGitHubDelivery()` (`src/server/webhooks/ingest.ts`).
Checks run in this order, and nothing is parsed or stored before the signature verifies:

| Step                                                                         | Failure → response      |
| ---------------------------------------------------------------------------- | ----------------------- |
| Body ≤ 2 MB (declared `Content-Length` first, then actual bytes)             | 413                     |
| `X-Hub-Signature-256` present                                                | 401 `missing_signature` |
| `sha256=` + HMAC-SHA256(secret, **raw bytes**), constant-time compare        | 401 `invalid_signature` |
| `X-GitHub-Delivery` (GUID-like) and `X-GitHub-Event` present and well-formed | 400                     |
| `Content-Type: application/json`                                             | 415                     |
| JSON parses; `issues`/`pull_request` payloads have the fields we need (Zod)  | 400 `malformed_payload` |

Then, in ONE transaction: insert the `webhook_events` row
(`ON CONFLICT (delivery_id) DO NOTHING`) and, for deliveries we act on, its `jobs` row.
Responses: 202 `queued`, 200 `ignored` (with reason), 200 `duplicate`, 500 if the
database write failed (never a 2xx for something we did not store).

- Idempotency: `delivery_id` is UNIQUE, so a redelivery — or two concurrent copies of
  the same delivery — produces one event and one job; the database arbitrates the race.
- Ignore reasons (event recorded, no job): `ping` (sent when the hook is created),
  `unsupported_event`, `repository_not_connected` (no subject content is kept for these),
  and `unknown_hook` — only the hook id we installed (`X-GitHub-Hook-ID` =
  `repositories.webhook_id`) may trigger automation. A second hook with our URL would
  otherwise deliver every event twice under different delivery ids.
- Stored subject: kind, number, title, body (first 10,000 chars), URL, state, author,
  labels. The full payload is not stored.
- Rate limiting: deliberately none on this endpoint. The HMAC check is cheap and happens
  before any database access; a database-backed limiter would add a write for every
  forged request and could throttle legitimate GitHub bursts. Vercel's platform DDoS
  mitigation still applies.

### Reliable processing

The event row and its job row are written in the same transaction, so an acknowledged
event always has a job (transactional outbox). `drainJobs()` (`src/server/jobs/worker.ts`)
processes due jobs until a time budget runs out; it is triggered by:

1. `after()` in the webhook route, right after the 202 response (Vercel `waitUntil`),
   with a 50s budget (`maxDuration = 60`). It also waits for its _own_ short retries
   within that budget, so a transient error is retried within seconds.
2. `GET /api/cron/worker`, protected by `Authorization: Bearer $CRON_SECRET`
   (constant-time compare), called by the GitHub Actions workflow
   `.github/workflows/worker-sweep.yml` every ~5 minutes (best-effort timing) and by a daily
   Vercel cron (`vercel.json`). It also purges expired sessions and stale rate-limit rows,
   and returns counts only (its output lands in public workflow logs).
3. The dashboard's "Retry failed steps" action (owner-checked; see Dashboard).

Correctness never depends on the trigger: all state is in Postgres, and every trigger
just drains whatever is due.

Queue mechanics (`src/server/jobs/queue.ts`):

- **Claim**: `UPDATE jobs … WHERE id IN (SELECT id … FOR UPDATE SKIP LOCKED) RETURNING *`
  takes pending jobs whose `run_at` passed and running jobs whose lease expired;
  concurrent workers get disjoint jobs. The claim sets a 120s lease (`locked_until`) and
  increments `attempts`, so a job that keeps crashing its worker still runs out of attempts.
- **Fencing**: completing, rescheduling or failing a job requires
  `(id, status = running, attempts = <claimed value>)`. A worker whose lease expired and
  was re-claimed updates zero rows instead of overwriting the new owner's state.
- **Retry**: transient failures reschedule with exponential backoff and ±20% jitter
  (~30s, 60s, 2m, 4m, 8m; capped at 1h), `max_attempts = 6`. On the final attempt a
  transient failure is recorded as a permanent one ("gave up after N attempts").
- **Recovery**: a job whose worker died during its final attempt can never be claimed
  again; `reapAbandonedJobs()` marks it failed, and `abandonEvent()` marks the event and
  every unfinished step failed with the reason — nothing stays "processing" forever.

Processing an event (`processEvent()` in `src/server/automation/process-event.ts`) is
safe to repeat:

- Matching rules are evaluated and one `automation_runs` row per (event, rule) is inserted
  with `ON CONFLICT DO NOTHING` (UNIQUE index), so a retried job reuses its runs. The run
  snapshots the rule's name, action and value, so editing or deleting a rule later does
  not change history.
- Each run has two steps with their own persisted status and attempt counters: GitHub
  write-back, then Slack. A step that succeeded is never executed again, so a Slack
  failure cannot repeat or undo the GitHub action. Slack runs only once the GitHub step is
  terminal, so the notification reports the real outcome — including failures.
- Order within one attempt: the GitHub steps of all runs, then the optional AI triage
  (once per event), then the Slack steps. The label/comment never waits for the AI, and
  the Slack message can include the suggestion. An AI failure is recorded on the event and
  never makes the job retry (see "Optional AI").
- Error classification: an error's `retryable` flag decides (GitHub network/timeout, 5xx,
  429 and rate-limit 403 are retryable; other 4xx and a revoked authorization are not).
  Errors without the flag are treated as transient.
- A finished event (`processed`/`ignored`) is a no-op, and an event whose repository was
  disconnected before processing is marked `ignored` (`repository_disconnected`).

Step idempotency inside the executors (GitHub/Slack):

- **Add label** (`src/server/automation/github-executor.ts`): reads the issue's current
  labels first (names compared case-insensitively, as GitHub treats them); if present, the
  step succeeds without a write (`alreadyApplied: true`). Otherwise it looks the label up in
  the repository's label list and adds it under its canonical name. A label that does not
  exist is a clear, permanent failure — GitHub's documentation does not say what "add
  labels" does with unknown names, and a typo in a rule must not silently create labels.
- **Comment**: the body is the rule's text, a small "Posted automatically by Automation
  Bot · rule …" footer, and a hidden marker `<!-- github-automation-bot:run:<run id> -->`.
  Before posting, comments updated since shortly before the run was created (`since=`) are
  scanned for that marker **by the same GitHub account**; if found, the step succeeds with
  that comment. A retry after "posted but not recorded" therefore never posts twice, and a
  marker pasted by someone else cannot suppress the comment.
- **Slack**: incoming webhooks have no idempotency key, so Slack delivery is
  at-least-once in the narrow window where a POST succeeds but the process dies before
  recording it. Status is written immediately after the POST to keep that window small.

### Rule engine

A rule belongs to one of the user's connected repositories and matches on: event type
(`issues` / `pull_request`), the event's `action` (`opened`, `edited`, `reopened`; one or
more), and optional keywords — case-insensitive substring match, ANY keyword, against the
title or the title + body. No keywords = every event of that type/action. Actions:
`add_label` (label name ≤ 50 characters, GitHub's limit) or `add_comment` (≤ 2,000
characters), plus a Slack toggle and an AI triage toggle (off by default, because it sends
the issue text to a third-party AI provider). Evaluation is a pure function
(`ruleMatchesEvent`) run at processing time; each matching rule produces one automation
run.

API (all through `withUser()`, every query scoped by the session user's id):

| Method               | Path                         | Notes                                                                         |
| -------------------- | ---------------------------- | ----------------------------------------------------------------------------- |
| GET                  | `/api/rules[?repositoryId=]` | the caller's rules, with repository name and connection state                 |
| POST                 | `/api/rules`                 | `repositoryId` must be one of the caller's **active** repositories (else 404) |
| GET / PATCH / DELETE | `/api/rules/:id`             | another user's rule id → the same 404 as an unknown id                        |

Validation is Zod with strict objects (unknown keys are rejected, so a typo cannot silently
do nothing). Keywords are trimmed, lower-cased and de-duplicated (≤ 10, each ≤ 50
characters). A PATCH is merged into the stored rule and the **merged** rule is validated
as a whole — e.g. switching a comment rule to `add_label` while keeping a 200-character
value is rejected. The repository of a rule cannot be changed. Deleting a rule sets
`automation_runs.rule_id` to null; runs keep their snapshot of the rule's name, action
and value.

### GitHub API

A thin typed wrapper around `fetch` against `https://api.github.com`, using the
connecting user's OAuth token (so writes appear as that user; the comment footer makes the
automation visible). Every call sets `Accept: application/vnd.github+json`,
`X-GitHub-Api-Version: 2026-03-10` (latest supported version; its breaking changes only
remove fields this app does not read) and a 10s timeout, and raises a typed
`GitHubApiError` carrying status, GitHub's message and validation details, and whether it
is retryable: network/timeout, 5xx, 429 and rate-limit 403s (primary, `retry-after`, or a
"secondary rate limit" message) are; other 4xx are not.

Labels and comments on pull requests use the Issues endpoints ("every pull request is an
issue"). The GitHub step maps failures to actionable messages: 401 → the user is flagged
for re-authentication; 404 → the issue/PR no longer exists or is inaccessible; 410 →
issues are disabled; other 403s → denied with GitHub's reason.

### Slack

The Slack step (`src/server/automation/slack-executor.ts`) runs once the GitHub step is
terminal and posts its real outcome to a Slack Incoming Webhook:

- **Destination**: the user's own webhook (Settings page, stored AES-256-GCM encrypted) →
  otherwise the deployment default `SLACK_WEBHOOK_URL` → otherwise the step is `skipped`
  with the reason "No Slack webhook is configured" (never reported as sent). A saved URL
  that no longer decrypts is reported, not silently replaced by the default.
- **Message**: fallback `text` plus Block Kit blocks — repository, event, linked
  issue/PR title, author, matched rule, action (label added / already present / comment
  link), status ✅/❌ and, on failure, the error. User-controlled text is escaped
  (`&` `<` `>`), so an issue titled `<!channel>` cannot ping a channel or inject links.
- **SSRF guard** (`src/lib/slack-url.ts`, also applied to `SLACK_WEBHOOK_URL` at startup):
  https, host exactly `hooks.slack.com`, default port, no credentials, path under
  `/services/`, no query. Redirects are not followed.
- **Errors**: success is HTTP 200 with body `ok`. 4xx (e.g. `404 no_service`) are
  permanent; 429 (Slack allows ~1 message/second per webhook) and 5xx/network errors are
  retryable — the job retries only the Slack step.
- **Secrecy**: Slack documents that the webhook URL contains a secret and revokes leaked
  ones. It is never returned by the API, shown again in the UI, logged, or put in errors.
- **Delivery semantics**: incoming webhooks have no idempotency key, so delivery is
  at-least-once in the window where Slack accepted the POST but recording it failed.

API: `GET /api/settings/slack` (source: `user` | `default` | `none`),
`PUT /api/settings/slack { webhookUrl }`, `DELETE /api/settings/slack`, and
`POST /api/settings/slack/test` (sends a real test message; 5 per minute per user).

### Dashboard

Pages (each calls `requireUser()`; data comes from the APIs below, which scope every query
by the session user and answer 404 for other users' ids):

- **Overview** `/dashboard`: stat cards (connected repositories, enabled rules, events
  received total/24 h, successful actions, failed runs, retries pending), recent activity,
  recent failures (step, reason, attempt count, time), connected repositories.
- **Activity** `/dashboard/activity`: table — time, repository, event, actor, title,
  rule → action, GitHub step, Slack step, status — with filters (all / failures / in
  progress) and cursor pagination. Status is explicit about "No rule matched",
  "Retrying (n/6) · next attempt in …", "Completed with failures".
- **Event detail** `/dashboard/activity/[id]`: delivery (repository, event, actor,
  delivery id, labels, body preview, timestamps), processing (job status, attempts, next
  attempt, last error), and each matched rule's GitHub and Slack steps with attempts and
  errors, plus the AI triage (summary, suggested label, priority, model — or why it failed
  or was skipped). "Retry failed steps" is shown when something failed, including the AI
  triage. The activity table shows the AI's priority and suggested label under the title.
- **Repositories**, **Rules**, **Settings** (Slack) as described above.

Live updates are TanStack Query polling (activity every 5 s, stats/failures every 10 s,
an in-progress event every 3 s). Polling pauses while the tab is hidden. No WebSockets:
polling is enough at this scale and works on serverless without extra infrastructure.

API: `GET /api/events?limit=&before=&filter=`, `GET /api/events/:id`, `GET /api/stats`,
`POST /api/events/:id/retry`. A manual retry (`src/server/events/retry.ts`) runs in a
transaction with the event and job rows locked: it resets only failed steps (a Slack
failure never repeats a successful GitHub action; a retried GitHub step also re-sends
Slack so the new outcome is reported), gives the job a fresh attempt budget, refuses
(409) while the job holds a valid lease or when nothing failed, and then drains the queue
in `after()`.

### Optional AI

A rule with **AI triage** on asks Google Gemini for a suggestion about the issue or pull
request: a one- or two-sentence summary, a suggested label (`bug`, `enhancement`,
`documentation`, `question`, `security` or `none`) and a priority (`low` … `critical`).
Facts verified against Google's documentation on 2026-09-30:

- **API**: REST `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
  (Google's docs say it "remains fully supported"; the newer Interactions API is in beta).
  The key goes in the `x-goog-api-key` header, never in the URL. JSON output is requested
  with `generationConfig.responseFormat.text` (`mimeType: APPLICATION_JSON` plus a JSON
  Schema); the older `responseSchema` field is marked deprecated.
- **Model**: `gemini-3.5-flash-lite` by default (stable, has a free tier, thinks
  "minimal" by default, which Google recommends for classification). `GEMINI_MODEL`
  overrides it; the id is validated because it becomes part of the request path.
- **Free tier**: no billing account needed; rate limits are per Google Cloud project and
  shown only in AI Studio; exceeding them returns `429 RESOURCE_EXHAUSTED`. On the free
  tier Google may use prompts and responses to improve its products and human reviewers
  may read them, and Google's terms say not to submit sensitive, confidential or personal
  information. This app only connects public repositories, so the text sent is already
  public, and the feature is opt-in per rule.

Design (`src/server/ai/`, `src/server/automation/ai-executor.ts`):

- **Once per event**, not per rule, stored on `webhook_events` (`ai_status`, `ai_result`,
  `ai_model`, `ai_error`, `ai_completed_at`). It runs only if a matched rule asks for it
  and `ai_status` is still null, so job retries never repeat it.
- **Never blocks**: any failure (no key → `skipped` with the reason; quota, network,
  invalid output → `failed` with the reason) is recorded, and GitHub and Slack carry on.
  It is not retried automatically; "Retry failed steps" clears a failed triage and runs it
  again without repeating steps that succeeded.
- **Untrusted input**: the title/body (body cut to 4,000 characters) only appear in the
  user message between `<<<BEGIN UNTRUSTED>>>` markers; the system instruction says to
  treat them as data. Because the output is display-only, a successful prompt injection
  can at worst produce a misleading suggestion.
- **Untrusted output**: the JSON is parsed and validated with Zod (enums compared
  case-insensitively, extra fields dropped); the summary has control characters removed
  and is clipped to 300 characters; Slack escapes it like any other user text and React
  escapes it in the dashboard. Nothing in the bot acts on the suggestion.
- **Quota protection**: 30 AI calls per hour per account (Postgres rate limiter), so one
  busy or spammed repository cannot use up the deployment's shared free quota.
- **Secrecy**: the key is only in server env vars, is scrubbed from any error text before
  it is stored or logged, and the browser only learns whether AI is configured
  (`aiAvailable` on `GET /api/rules`).

### Observability

Every log line is one JSON object (`src/server/logger.ts`) with `level`, `event` and
`timestamp`; keys that look like secrets are redacted, and payloads, issue bodies, tokens
and webhook URLs are never logged. On Vercel they appear in the project's runtime logs and
can be searched by `event` or by a delivery id.

Lines about one event carry `eventId`, `deliveryId` (GitHub's `X-GitHub-Delivery`, also
shown in the dashboard), `repository` and `attempt`; worker lines carry `jobId`. Steps
record `durationMs`.

| Stage    | Events                                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Webhook  | `github_webhook_received`, `github_webhook_rejected` (with reason), `github_webhook_duplicate`, `github_webhook_ignored`, `job_created`                                                                                         |
| Worker   | `job_started`, `job_succeeded`, `job_retry_scheduled` (delay, error), `job_failed_permanently`, `job_crashed`, `job_lease_lost`                                                                                                 |
| Rules    | `rules_evaluated` (count), `rule_matched` (one per rule)                                                                                                                                                                        |
| Steps    | `github_action_succeeded` / `github_action_failed`, `ai_triage_succeeded` / `ai_triage_failed` / `ai_triage_skipped`, `slack_notification_sent` / `slack_notification_skipped` / `slack_notification_failed`, `event_processed` |
| Triggers | `drain_after_webhook_completed`, `cron_worker_completed`, `drain_after_retry_completed`                                                                                                                                         |

The dashboard is the other half: every failure is persisted with its reason and attempt
count and shown on the Overview ("Recent failures"), in the Activity filter "Failures",
and on the event detail page.

### Deployment

Single Vercel project connected to the GitHub repository. Environment variables are set in
Vercel project settings. Migrations are applied with `npm run db:migrate` against Neon.

## Security boundaries

| Boundary                  | Control                                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| Internet → webhook        | HMAC-SHA256 over raw body, timing-safe compare, header/shape validation, body size cap.            |
| Internet → auth           | OAuth `state` + PKCE, rate limiting, safe redirects (internal paths only).                         |
| Browser → API             | Session cookie (HttpOnly, Secure, SameSite=Lax), same-origin `Origin` check on mutations.          |
| User A → User B's data    | Every query is scoped by `user_id` from the session; IDs from the client are never trusted alone.  |
| Scheduler → worker        | `Authorization: Bearer ${CRON_SECRET}`, timing-safe compare.                                       |
| App → GitHub/Slack/Gemini | Secrets only in server env vars; tokens encrypted at rest; logs redact secrets.                    |
| User input → Slack URL    | Allow-list `hooks.slack.com` (prevents SSRF to internal addresses).                                |
| Rendering                 | React escapes output; no `dangerouslySetInnerHTML`.                                                |
| Issue text ↔ AI           | Issue text is delimited as untrusted data; AI output is validated, clipped, escaped, display-only. |
