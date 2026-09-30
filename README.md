# Event-Driven GitHub Automation Bot

**Live app:** https://github-automation-bot-seven.vercel.app ·
**Design:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
**How this was built with AI:** [AI_NOTES.md](AI_NOTES.md)

## Overview

Sign in with GitHub, connect a public repository, and describe a rule such as _"when an
issue is opened and its title contains `bug`, add the `bug` label and tell Slack"_. From
then on GitHub sends the repository's issue and pull-request events to the bot, which
verifies and stores each delivery, runs your rules in the background, writes the result
back to GitHub, posts the real outcome to Slack and shows every step in a dashboard.

Nothing is simulated: sign-in is GitHub OAuth, the webhook is created on your repository
through the GitHub API, labels and comments are real GitHub API writes, notifications are
real Slack messages, and all state lives in Postgres. An optional AI step (Google Gemini)
adds a triage suggestion.

## Features

- **GitHub sign-in**: OAuth App with `state` and PKCE; expiring user tokens are refreshed
  automatically; tokens are encrypted at rest (AES-256-GCM) and never reach the browser.
- **Repository connection**: lists the public repositories you administer; _Connect_
  creates the repository webhook (secret, JSON, `issues` + `pull_request`), _Disconnect_
  removes it. Several repositories per account.
- **Webhook receiver**: HMAC-SHA256 signature verified over the raw body in constant time,
  size limit, header and payload validation, idempotency on GitHub's delivery ID, fast
  `202` acknowledgement.
- **Reliable processing**: the event and its job are stored in one transaction
  (transactional outbox); jobs are claimed with `FOR UPDATE SKIP LOCKED` and a lease,
  retried with exponential backoff and jitter (up to 6 attempts), and can be retried by
  hand from the dashboard.
- **Configurable rules**: issues or pull requests; `opened` / `edited` / `reopened`;
  keywords in the title or title and body; action _add label_ or _post comment_; optional
  Slack notification; optional AI triage.
- **Idempotent GitHub actions**: a label is only added if missing; a comment carries a
  hidden per-run marker, so a retried job never posts twice.
- **Slack notifications** of the real outcome (success or failure), through your own
  Incoming Webhook (stored encrypted) or a deployment default.
- **Dashboard**: overview stats, live activity log (polling), recent failures, and an
  event page with every step, attempt count, error and a _Retry failed steps_ button.
- **Optional AI triage** (Gemini free tier): summary, suggested label and priority, shown
  in the dashboard and in Slack — a suggestion only, never an action.
- **Observability**: structured JSON logs; every line about an event carries its GitHub
  delivery ID, so one delivery can be traced end to end.

## Architecture

```
GitHub ── issues / pull_request webhook ──► POST /api/webhooks/github
                                             verify signature → store event + job (1 transaction)
                                             → 202 → after(): drain jobs
                                                          │
GitHub Actions (every 5 min) ─┐                           ▼
Vercel cron (daily) ──────────┴─► GET /api/cron/worker ─► worker: claim job (SKIP LOCKED + lease)
                                  (Bearer CRON_SECRET)      → match rules
                                                            → GitHub: add label / post comment
                                                            → AI triage (optional, never blocks)
                                                            → Slack: report the outcome
Browser ── session cookie ──► Next.js pages + /api/* (every query scoped to the user)
                                             │
                                             ▼
                                      Neon Postgres
```

One Next.js application on Vercel serves the dashboard, the API and the webhook receiver.
Background work is a Postgres `jobs` table instead of a separate queue service. The full
design, trade-offs and rejected alternatives are in
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**Status of the two scheduled sweeps:** configured, but not yet observed running in
production — see [Known Limitations](#known-limitations). Every real event so far was
processed by the `after()` drain right after its webhook.

## Tech Stack

| Area            | Choice                                                                               |
| --------------- | ------------------------------------------------------------------------------------ |
| App and API     | Next.js 16 (App Router, Route Handlers, Node.js runtime), React 19, TypeScript       |
| UI              | Tailwind CSS 4, TanStack Query 5 (polling)                                           |
| Database        | PostgreSQL on Neon (free plan), Drizzle ORM 0.45 + `pg`, drizzle-kit migrations      |
| Background jobs | Postgres `jobs` table (outbox), drained by `after()`, GitHub Actions and Vercel Cron |
| Validation      | Zod 4                                                                                |
| Integrations    | GitHub REST API (`2026-03-10`), Slack Incoming Webhooks, Gemini API (optional)       |
| Tests           | Vitest 5, PGlite (in-process Postgres running the real migrations)                   |
| Hosting         | Vercel Hobby (free), Node.js 22                                                      |

## How It Works

1. You sign in with GitHub. The callback checks `state` and the PKCE verifier, stores your
   encrypted tokens and sets an HttpOnly session cookie.
2. _Connect_ on a repository checks that it is public and that you are an admin, then
   creates a webhook pointing at `/api/webhooks/github` with the app's secret.
3. When an issue or pull request changes, GitHub POSTs the event. The endpoint verifies
   `X-Hub-Signature-256`, validates the headers and payload, and inserts the event with
   `ON CONFLICT (delivery_id) DO NOTHING` plus its job in one transaction, then answers
   `202` — well inside GitHub's 10-second limit.
4. Right after the response, `after()` drains the queue. The worker claims the job, matches
   your enabled rules for that repository, and creates one run per matching rule.
5. Each run adds the label or posts the comment (checking first, so a retry never
   duplicates it), optionally asks Gemini for a triage suggestion, then posts the real
   outcome to Slack.
6. Transient failures (network, 5xx, rate limits) are retried with backoff. Permanent ones
   (for example a label that does not exist) are recorded with a clear message. Retries
   that are not due within the webhook request are picked up by the sweeper.
7. The dashboard polls the API and shows the event, each step's status, attempts and
   errors.

## Prerequisites

- Node.js 22 and npm
- A GitHub account (for the OAuth App and a public test repository you administer)
- A Neon account (free, no card) — or any PostgreSQL 16+ database
- Optional: a Slack workspace (free) for notifications
- Optional: a Google AI Studio API key (free tier, no card) for AI triage
- For deployment: a Vercel account (Hobby, free, no card)

## Local Setup

```bash
git clone https://github.com/Bablusharma13/github-automation-bot.git
cd github-automation-bot
npm install
cp .env.example .env     # then fill in the values (see below)
npm run db:migrate       # creates the tables in DATABASE_URL
npm run dev              # http://localhost:3000
```

## Environment Variables

All variables are read on the server only (none is exposed to the browser). `.env` is
git-ignored; [.env.example](.env.example) lists the names with instructions.

| Variable                | Required | Purpose                                                                                                                                                    |
| ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `APP_URL`               | yes      | Public origin of the app, no trailing slash (`http://localhost:3000` locally, `https://…` in production). Used for the OAuth callback and the webhook URL. |
| `DATABASE_URL`          | yes      | Postgres connection string (Neon pooled URL, `sslmode=verify-full`).                                                                                       |
| `GITHUB_CLIENT_ID`      | yes      | GitHub OAuth App client ID.                                                                                                                                |
| `GITHUB_CLIENT_SECRET`  | yes      | GitHub OAuth App client secret.                                                                                                                            |
| `GITHUB_WEBHOOK_SECRET` | yes      | Random secret (≥ 16 characters) the app sets on the webhooks it creates and verifies deliveries with.                                                      |
| `TOKEN_ENCRYPTION_KEY`  | yes      | 32 random bytes, base64. Encrypts GitHub tokens and Slack webhook URLs at rest.                                                                            |
| `CRON_SECRET`           | yes      | Bearer secret (≥ 16 characters) for `/api/cron/worker`.                                                                                                    |
| `SLACK_WEBHOOK_URL`     | no       | Deployment-wide default Slack Incoming Webhook for users who have not saved their own.                                                                     |
| `GITHUB_WEBHOOK_URL`    | no       | Overrides the webhook URL registered on GitHub (for a local HTTPS tunnel).                                                                                 |
| `GEMINI_API_KEY`        | no       | Enables AI triage. Without it, rules that ask for AI record the step as skipped.                                                                           |
| `GEMINI_MODEL`          | no       | Gemini model ID; defaults to `gemini-3.5-flash-lite`.                                                                                                      |

Generate random secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

The app validates the variables on first use and reports which ones are missing or invalid
(never their values). `GET /api/health` shows whether configuration and database are OK.

## GitHub OAuth Setup

Create one OAuth App per environment (the callback URL differs):

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Application name**: anything that does not start with "GitHub" (GitHub rejects that).
3. **Homepage URL**: your `APP_URL`.
4. **Authorization callback URL**: `${APP_URL}/api/auth/github/callback`.
5. Register, copy the **Client ID** into `GITHUB_CLIENT_ID`, generate a client secret and
   put it in `GITHUB_CLIENT_SECRET`.

"Expire user access tokens" can stay enabled: the app stores the refresh token and renews
the access token before background work needs it. At sign-in the app asks for
`read:user user:email public_repo` — enough to read your profile, manage webhooks and write
labels/comments on public repositories, and nothing on private ones.

## Repository/Webhook Setup

There is no manual webhook step. In the dashboard, **Repositories → Connect** creates the
webhook on GitHub:

| Setting          | Value                                                      |
| ---------------- | ---------------------------------------------------------- |
| Payload URL      | `${APP_URL}/api/webhooks/github` (or `GITHUB_WEBHOOK_URL`) |
| Content type     | `application/json`                                         |
| Secret           | `GITHUB_WEBHOOK_SECRET`                                    |
| Events           | `issues`, `pull_request`                                   |
| SSL verification | enabled                                                    |

Requirements: the repository is public and not archived, and you have admin permission
(needed to create webhooks). A repository can be connected by one account at a time.
GitHub sends a `ping` right away; it appears in the activity log as an _Ignored_ event
(reason: ping).
**Disconnect** deletes the webhook on GitHub. Rules need the label to exist in the
repository; new GitHub repositories come with default labels such as `bug`.

For local development GitHub cannot reach `localhost`: run an HTTPS tunnel (for example
`cloudflared tunnel --url http://localhost:3000`) and set `GITHUB_WEBHOOK_URL` to
`https://<tunnel-host>/api/webhooks/github` before connecting. (This project was tested
against the deployed app; the tunnel path is supported but was not used.)

## Slack Setup

1. Open https://api.slack.com/apps → **Create New App → From scratch**, name it, pick your
   workspace.
2. **Incoming Webhooks** → switch **On** → **Add New Webhook to Workspace** → choose a
   channel → **Allow**.
3. Copy the webhook URL (`https://hooks.slack.com/services/…`). It is a secret: anyone with
   it can post to that channel.
4. In the dashboard: **Settings** → paste the URL → **Save** → **Send test notification**.

The URL is stored encrypted and never shown again. Alternatively set `SLACK_WEBHOOK_URL` as
a default for every user. Without a webhook the Slack step is recorded as _skipped_ with
the reason, never as sent.

## Database Setup

1. Create a free project at https://neon.tech (no card).
2. Copy the **pooled** connection string, set `sslmode=verify-full`, and put it in
   `DATABASE_URL`.
3. Run `npm run db:migrate`. Migrations live in [drizzle/](drizzle) and are generated from
   [src/server/db/schema.ts](src/server/db/schema.ts) with `npm run db:generate`.

Use a separate Neon branch (or database) for local development so local experiments never
touch production data.

## Running Locally

```bash
npm run dev                  # development server on http://localhost:3000
npm run build && npm start   # production build
```

Sign in, connect a repository (through a tunnel, see above) and open an issue.

## Testing

```bash
npm test          # 262 tests in 25 files
npm run check     # typecheck + lint + tests
```

- Database tests run against **PGlite** (Postgres compiled to WebAssembly, in process) with
  the real migrations — no external database needed.
- GitHub, Slack and Gemini are mocked at the `fetch` level. A global guard in
  [tests/helpers/setup-env.ts](tests/helpers/setup-env.ts) makes any unmocked network call
  fail the test, so no test can reach a real API.
- Coverage by area: webhooks (valid, invalid and missing signature, tampered body,
  duplicates incl. concurrent ones, supported/unsupported events, malformed payloads,
  oversized bodies), rules (keyword match/mismatch, body scope, disabled rules, several
  rules), authorization (users only see and change their own repositories, rules, events
  and settings; other users' ids return 404), actions (GitHub label/comment success,
  permanent and transient failures, Slack success/failure, retries, idempotency), the job
  queue (leases, fencing, backoff, crash recovery), AI triage (validation, key handling,
  failures never block) and one end-to-end test: signed delivery → stored event and job →
  worker → label → AI → Slack → dashboard API → redelivery acknowledged as a duplicate.
- Security regressions: a test calls every browser-facing endpoint and checks that no
  response contains the GitHub token, its ciphertext, the Slack URL, the session token or
  a server secret.
- Important tests were mutation-checked: the code under test was deliberately broken to
  confirm that the test fails.
- Each DB-backed test file runs its own in-process Postgres; the suite uses at most 3
  workers. On a machine with little free memory (about 1.5 GB or less) workers can crash
  with memory errors — run `npx vitest run --maxWorkers=1` there.

What was verified against the real services is listed in
[Verification Status](#verification-status).

## Deployment

The app runs on Vercel Hobby:

1. Import the GitHub repository in Vercel (framework preset: Next.js; Node.js 22 comes from
   `package.json`).
2. Create a production GitHub OAuth App whose callback is
   `https://<your-domain>/api/auth/github/callback`.
3. In **Settings → Environment Variables** set the variables above for Production, with
   `APP_URL` = your production domain (not a per-deployment URL: those are behind Vercel
   Deployment Protection).
4. Run `npm run db:migrate` against the production database **before** deploying code that
   needs a new migration (all migrations so far only add tables or columns).
5. Deploy (every push to `main` deploys automatically). Changing an environment variable
   needs a redeploy.
6. Add the repository secret `CRON_SECRET` (same value as in Vercel) under GitHub →
   **Settings → Secrets and variables → Actions**, so the sweeper workflow can call the app.

Why not Vercel Cron alone: on the Hobby plan cron jobs run at most once a day, so
[vercel.json](vercel.json) only schedules a daily safety sweep and the frequent sweep is
the GitHub Actions workflow [.github/workflows/worker-sweep.yml](.github/workflows/worker-sweep.yml).

## Production Configuration

| Item                     | Value                                                                                                                                                   |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| App                      | https://github-automation-bot-seven.vercel.app (Vercel Hobby, functions in `iad1`)                                                                      |
| Health                   | https://github-automation-bot-seven.vercel.app/api/health                                                                                               |
| OAuth callback           | https://github-automation-bot-seven.vercel.app/api/auth/github/callback                                                                                 |
| Webhook URL (automatic)  | https://github-automation-bot-seven.vercel.app/api/webhooks/github                                                                                      |
| Database                 | Neon Postgres (free plan, `us-east-1`, pooled connection)                                                                                               |
| Sweeper                  | GitHub Actions every 5 min (scheduled runs not yet observed) + Vercel Cron daily at 03:00 UTC (first run due 2026-10-01) → `/api/cron/worker`           |
| Environment (names only) | `APP_URL`, `DATABASE_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `TOKEN_ENCRYPTION_KEY`, `CRON_SECRET`, `GEMINI_API_KEY` |

## Verification Status

State on 2026-09-30. **Verified** = observed in production (deployed app, real GitHub,
Slack, Neon, Gemini). **Manually tested** = done by the owner in the browser.
**Locally verified** = automated tests only. **Not yet confirmed** = not observed.

| Behaviour                                                                         | Status                    | Evidence                                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub sign-in (OAuth, `state` + PKCE)                                            | Manually tested; Verified | Owner signed in (latest 13:42 UTC). HTTP checks: `state` (43 chars), PKCE `S256`, scopes `read:user user:email public_repo`, forged `state` → `/login?error=invalid_state`.                                                                                                                                                                     |
| Repository connection + webhook                                                   | Manually tested; Verified | Owner connected `github-automation-bot` (13:07 UTC). GitHub API: exactly one hook, id equal to the stored one, events `issues` + `pull_request`, JSON, SSL verification on, secret set.                                                                                                                                                         |
| Explicit repository selection in the rule form                                    | Locally verified          | Code (`23b61d7`) and an API test that a rule without a repository is rejected; not viewed in a browser after that change.                                                                                                                                                                                                                       |
| Matching issue → label → AI → Slack → dashboard                                   | Verified                  | Issue #3 (13:33 UTC): `bug` label added, Gemini triage stored, Slack accepted the message, event processed in 2.4 s.                                                                                                                                                                                                                            |
| Non-matching issue                                                                | Verified                  | Issue #4 (14:49 UTC): event recorded with 0 runs; no label or other change on GitHub.                                                                                                                                                                                                                                                           |
| Redelivery of a real delivery                                                     | Verified                  | Issue #3's delivery redelivered (14:50 UTC): GitHub reused the delivery ID, the app answered `200` duplicate, still one event, one job and one run; the label was added once.                                                                                                                                                                   |
| Failure → manual retry                                                            | Verified                  | Issue #5 (14:52 UTC): rule label missing → run failed with a clear message, Slack notified; label created → the app's retry function reset the failed steps and the production worker applied the label (14:55 UTC). The retry was started by calling the retry service, not the dashboard button (the button's API route is covered by tests). |
| Processing right after each webhook (`after()`)                                   | Verified                  | Every real event above was processed within ~1–3 s.                                                                                                                                                                                                                                                                                             |
| `/api/cron/worker` authentication and draining                                    | Verified                  | 401 without or with a wrong secret; 200 with the secret; it drained the retried job of issue #5.                                                                                                                                                                                                                                                |
| Scheduled GitHub Actions sweep (every 5 min)                                      | **Not yet confirmed**     | 0 scheduled runs; fix `e2e2d4f` pushed at 13:54 UTC.                                                                                                                                                                                                                                                                                            |
| Daily Vercel cron                                                                 | **Not yet confirmed**     | Configured; first run due 2026-10-01 around 03:00 UTC.                                                                                                                                                                                                                                                                                          |
| Transient failures, backoff, leases, crash recovery                               | Locally verified          | Queue, worker and processing tests.                                                                                                                                                                                                                                                                                                             |
| Webhook signature checks, anonymous and cross-origin API access, security headers | Verified                  | Forged or missing signature → 401; anonymous API → 401; cross-origin mutations → 403; CSP, `X-Frame-Options`, `nosniff`, HSTS present.                                                                                                                                                                                                          |
| No tokens or secrets in API responses                                             | Locally verified          | Test `25398d2`; browser responses in production not inspected.                                                                                                                                                                                                                                                                                  |
| Users cannot access each other's data                                             | Locally verified          | Authorization tests; needs a second account in production.                                                                                                                                                                                                                                                                                      |
| No secrets in logs                                                                | Locally verified          | Logger redaction and log tests; production logs not inspected.                                                                                                                                                                                                                                                                                  |

## Demo / Evaluation Instructions

You need a GitHub account and a **public repository you administer** — for example create
a new empty public repository `bot-test` (it gets GitHub's default labels, including `bug`).
You cannot use someone else's repository: the bot needs admin rights to install its webhook.

1. Open https://github-automation-bot-seven.vercel.app and click **Sign in with GitHub**.
2. Authorize the **Automation Bot** OAuth app. You land on the dashboard.
3. **Repositories** → **Connect** next to your test repository. GitHub's ping appears in
   **Activity** as an _Ignored_ event (reason: ping) within seconds — the webhook works.
4. Optional, for Slack: create an Incoming Webhook ([Slack Setup](#slack-setup)), then
   **Settings** → paste it → **Save** → **Send test notification**. Without it the Slack
   step shows _Skipped_ with the reason "No Slack webhook is configured (Settings →
   Slack)".
5. **Rules** → **New rule** (the defaults already describe the standard test, except the
   repository, which is never pre-selected):
   - Repository: choose your test repository
   - Event: **Issue**, when it is **opened**
   - Keywords: `bug`, look in **Title**
   - Action: **Add label** `bug`
   - ☑ Send a Slack notification · optionally ☑ Add an AI triage suggestion
   - **Create rule**
6. In your repository open an issue titled **`Bug: login button is broken`**.
7. Within a few seconds:
   - the issue has the `bug` label (added through your authorization, so GitHub shows it
     as done by you);
   - Slack shows the rule, action and ✅ status (plus the AI suggestion if enabled);
   - **Activity** shows the event as _Succeeded_; click it to see the delivery ID, the
     GitHub step, the Slack step and the AI triage.
8. Negative test: open **`Feature: dark mode`** → Activity shows _No rule matched_ and no
   label is added.
9. Failure and retry: create a rule whose label does not exist (e.g. `needs-triage`), open a
   matching issue → the run fails with _Label "needs-triage" does not exist…_. Create that
   label on GitHub (**Issues → Labels → New label**), open the event, click **Retry failed
   steps** → it succeeds without repeating steps that already worked.
10. Redelivery: on GitHub, **Settings → Webhooks → your hook → Recent Deliveries →
    Redeliver**. GitHub resends the delivery with its original delivery ID (observed on
    2026-09-30), so the bot answers _duplicate_ and nothing runs twice.
11. When done, **Repositories → Disconnect** removes the webhook from your repository.

## Security & Reliability

- Webhooks: signature checked first, over the raw bytes, in constant time; 2 MB limit;
  strict header/payload validation; deliveries from an unknown hook ID are ignored.
- Sessions: random 256-bit tokens, only their SHA-256 stored; `__Host-` cookie, HttpOnly,
  Secure, SameSite=Lax; logout deletes the session.
- API: every query is scoped to the session user; another user's IDs return 404; every
  mutation requires the session plus a same-origin `Origin` header; Zod validation on all
  input; generic error messages for clients, details in server logs.
- Secrets: only in server environment variables; GitHub tokens and Slack URLs encrypted
  with AES-256-GCM; the logger redacts secret-like keys; no secrets in the repository.
- Abuse limits: Postgres-backed rate limits for sign-in, mutations and Slack tests; AI calls
  capped at 30 per hour per account.
- Outbound: Slack URLs are restricted to `https://hooks.slack.com/services/…` (SSRF guard);
  redirects are not followed; all external calls have timeouts.
- Headers: CSP `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, strict
  referrer policy; HSTS from Vercel.
- Reliability: transactional outbox; `UNIQUE(delivery_id)` and `UNIQUE(event, rule)`
  constraints make redelivery and job retries safe; job leases with fencing tokens;
  exponential backoff with jitter; failures are persisted, shown and retryable;
  nothing is reported as successful unless the API call succeeded.

## AI Feature

Rules can opt in to **AI triage**. For a matching issue or pull request, the bot sends the
title and body (body cut to 4,000 characters) to the Gemini API (`generateContent`,
structured JSON output) and stores a one- or two-sentence summary, a suggested label
(`bug`, `enhancement`, `documentation`, `question`, `security` or `none`) and a priority
(`low` to `critical`). The result is shown on the event page, in the activity table and in
the Slack message, marked as a suggestion.

- The suggestion never triggers an action; the rule decides what happens.
- The model output is validated with Zod, cleaned, length-limited and escaped.
- Issue text is passed as clearly delimited untrusted data, with instructions not to follow
  it.
- AI failures (no key, quota, network, invalid output) are recorded and shown; GitHub and
  Slack steps are never blocked. _Retry failed steps_ re-runs a failed triage.
- Configuration: `GEMINI_API_KEY` (from https://aistudio.google.com/apikey, free tier, no
  card), optional `GEMINI_MODEL` (default `gemini-3.5-flash-lite`).
- Privacy: on Gemini's free tier Google may use prompts to improve its products and human
  reviewers may read them. This app only connects public repositories, and AI triage is
  off unless a rule turns it on.

## Project Structure

```
src/
  app/                    Next.js routes
    api/                  Route handlers (thin): auth, repositories, rules, events, stats,
                          settings/slack, webhooks/github, cron/worker, health
    dashboard/            Overview, Activity (+ event page), Repositories, Rules, Settings
    login/                Sign-in page
  components/             Client components (activity feed, rule form, Slack settings, …)
  lib/                    Client-safe shared types and constants
  server/                 All business logic, testable without Next.js
    auth/                 OAuth flow, sessions, current-user helpers
    github/               REST client, OAuth, token refresh, repository webhooks
    webhooks/             Signature check, payload parsing, ingestion
    jobs/                 Queue (claim/lease/fence), worker, backoff, cron handler
    automation/           Event processing, GitHub/Slack/AI step executors
    rules/                Validation, matching, CRUD
    events/               Activity log, stats, manual retry
    slack/                Client, message builder, settings
    ai/                   Gemini client, prompt, output validation
    db/                   Drizzle schema and connection
drizzle/                  SQL migrations
tests/                    unit/ and integration/ (PGlite), helpers/
docs/ARCHITECTURE.md      Design and decisions
.github/workflows/        Worker sweep schedule
```

## Known Limitations

- **Public repositories only**: the OAuth scope is `public_repo`, so private repositories
  cannot be connected.
- **Actions appear as the user**: the bot writes labels and comments with the connecting
  user's OAuth token, not as a separate bot identity (a GitHub App would fix this).
  Comments carry a footer saying they were posted automatically.
- **Scheduled sweeps are not yet confirmed**: retries that are not due within the webhook
  request's ~50-second window depend on the sweeper. The GitHub Actions schedule had never
  triggered (0 scheduled runs); a fix was pushed in `e2e2d4f`, but no scheduled run had
  been observed when this was written. The daily Vercel cron has not run yet either (the
  first production deployment was after 03:00 UTC on 2026-09-30, so its first run is due
  on 2026-10-01). Even when working, GitHub may delay or drop scheduled runs under load.
  All job state is in Postgres, so a late sweep delays a retry but never loses work.
- **Slack is at-least-once in a narrow window**: Incoming Webhooks have no idempotency key;
  if the process dies after Slack accepted a message but before it was recorded, a retry
  can repeat that message.
- **Rules are simple**: one condition type (keywords in title/body), one action per rule,
  issues and pull requests only (`opened`, `edited`, `reopened`).
- **Labels must already exist** in the repository; the bot does not create them.
- **AI suggestions** depend on Gemini's free-tier limits and may be wrong; they are never
  acted upon.
- **Polling, not push**: the dashboard refreshes every few seconds.
- **Local webhooks need a tunnel**, and in this project the local environment shared the
  production database (with different encryption keys); a separate Neon branch is
  recommended.

## Future Improvements

- GitHub App instead of an OAuth App: bot identity, per-repository permissions, private
  repositories, no user token in background work.
- Richer rules: label/author/branch conditions, AND/OR, several actions per rule.
- A queue with push delivery (e.g. Vercel Queues once generally available) instead of
  polling sweeps.
- Server-sent events for the dashboard instead of polling.
- Metrics and alerting (error rate, queue age) on top of the structured logs.
- Using the AI suggestion as an optional, user-confirmed action.
