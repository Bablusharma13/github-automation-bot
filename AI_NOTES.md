# AI_NOTES

How this project was built with an AI assistant. Everything below happened in this
project (built on 2026-09-29 and 2026-09-30); the commits, the running app and the issues
in this repository are the evidence.

## AI tools used

- **Claude Code only — VS Code extension using Claude Opus 5.5.** (Model ID
  `claude-opus-5-5`.)
- No other AI tool was used. Commits written by Claude carry a
  `Co-Authored-By: Claude Opus 5.5` trailer.

## How AI and I divided the work

### What Claude did

- Proposed the architecture and wrote all application code, tests, database migrations,
  the GitHub Actions workflow and the documentation (README, `docs/ARCHITECTURE.md`,
  `CLAUDE.md`, `.env.example`, and this file from my answers).
- Checked the official documentation before relying on an API (GitHub REST API version and
  expiring OAuth tokens, Slack Incoming Webhooks, Vercel Hobby limits, Neon, Gemini API).
- Ran Prettier, typecheck, ESLint, the test suite and a production build before every
  commit, deliberately broke code to confirm that important tests fail (mutation checks),
  and verified production behaviour with read-only database queries and public GitHub API
  calls.
- Wrote the step-by-step instructions I followed for each external service.

### What I reviewed, changed and tested

- **External setup (done by me):** Neon project and database, two GitHub OAuth Apps
  (development and production), the Vercel project and its environment variables, the
  Slack app and Incoming Webhook, the Gemini API key (Google AI Studio, free tier) and the
  `CRON_SECRET` GitHub Actions secret.
- **Manual testing (done by me):** in the browser against the deployed app — GitHub
  sign-in, connecting and disconnecting repositories, creating and editing rules, opening
  real issues (#1–#3) in this repository, and checking the labels on GitHub, the Slack
  messages and the dashboard. I reported what I saw, with screenshots, back to Claude.
- **Review:** I did not review the source code or diffs myself. I reviewed Claude's
  proposals, explanations and phase summaries during the session, the results in the
  running app, and this documentation before it was committed.
- **Code manually edited:** none. All application source code was written by Claude. I only
  edited configuration values (my local `.env` and the Vercel environment variables), which
  is not source code.

### Architecture: proposed by Claude, reviewed and approved by me

These are not my own designs:

- **PostgreSQL job table as a transactional outbox** — the event and its job are written in
  one transaction; jobs are claimed with `FOR UPDATE SKIP LOCKED` and a lease. Chosen over
  BullMQ + Redis because no free, no-card host offers an always-on worker process.
  _Claude proposed this approach; I reviewed and approved it._
- **Vercel Hobby + Neon Postgres** — free without a card and always reachable, so GitHub's
  10-second webhook timeout is safe (a free Render service would sleep).
  _Claude proposed this approach; I reviewed and approved it._
- **Idempotency on GitHub's delivery ID** — `UNIQUE(delivery_id)` with
  `ON CONFLICT DO NOTHING`, plus one run per (event, rule).
  _Claude proposed this approach; I reviewed and approved it._
- **Retry and reliability design** — exponential backoff with jitter (6 attempts), fenced
  job leases, and three triggers: `after()` in the webhook route, a GitHub Actions sweeper
  and a daily Vercel cron (the two scheduled triggers are not yet confirmed in production —
  see item 6 below). _Claude proposed this approach; I reviewed and approved it._
- **Security and session design** — OAuth with `state` and PKCE, hashed session tokens in
  HttpOnly cookies, AES-256-GCM for GitHub tokens and Slack URLs, every query scoped to the
  signed-in user (404 for other users' data), same-origin checks on mutations.
  _Claude proposed this approach; I reviewed and approved it._
- **AI triage as a display-only suggestion** (Gemini free tier, validated output, never
  blocks or triggers an action). _Claude proposed this approach; I reviewed and approved
  it._

## 2–3 decisions I made myself

1. **Direct Vercel deployment.** During Phase 3 (repository connection) I chose to deploy
   to Vercel right away instead of relying on a local Cloudflare tunnel, so the real
   GitHub webhook flow could be tested against a publicly reachable deployment. As a
   result every webhook test ran against the deployed app; the tunnel option
   (`GITHUB_WEBHOOK_URL`) exists but was never used.
2. **Testing on the project repository.** I chose to connect and test with this
   `github-automation-bot` repository and real issues and events instead of a separate
   sandbox repository. Issues #1–#3 here are those tests.
3. **Commits under my own Git identity.** Claude found that every commit so far was
   attributed on GitHub to a different account, because of the previous company-related
   email in my git configuration. I chose to correct the git email for this repository so
   that commits are associated with my own GitHub account (Bablusharma13), from commit
   `e2e2d4f` on. The earlier history was left unchanged (no rewrite, no force push).

## Hardest AI mistake / wrong turn: wrong repository selected during rule creation

1. **What the AI suggested.** Claude's first rule form pre-selected the first repository in
   the list instead of requiring a choice, and Claude's test instructions told me the
   default values were fine. With two repositories connected, the pre-selected one was the
   most recently connected repository (`Resume-Creator`), not `github-automation-bot`.
2. **Why it was wrong.** A silently chosen default decided which repository the rule
   watched, so the rule was saved for the wrong repository. The issue in
   `github-automation-bot` matched no rule, and the dashboard showed the event as processed
   without saying that nothing matched.
3. **How I noticed.** During real end-to-end testing I opened issue #1 ("Bug: login button
   is broken") and the expected `bug` label was never added. I reported it to Claude with a
   screenshot.
4. **What exposed it.** Not the unit tests — they all passed. Claude queried the production
   database: the delivery had been received and processed (the job succeeded) but produced
   zero automation runs, and the rule belonged to the other repository.
5. **How it was fixed** (commit `7516002`). The form pre-selects a repository only when
   exactly one is connected; otherwise the repository must be chosen explicitly. Rule cards
   name their repository, and the overview shows "No rule matched". Once the rule was saved
   on the right repository, the next test issue (#2) was labeled automatically.
   - **Tests — what exists:** the fix added an automated test for the "No rule matched" /
     matched-rule count (it also caught a query bug in that count). When the dashboard was
     rebuilt (`ed1a396`) that check moved to a unit test of the status logic
     (`tests/unit/activity-status.test.ts`).
   - **Tests — what does not exist:** there is no automated UI test for the
     repository-selection behaviour itself. (The correct rule was created before the fixed
     form was deployed, so the new form has not been exercised with two repositories in
     production either.)
6. **What I learned.** Only testing the real flow end to end caught this: every automated
   test passed while the product did the wrong thing. A default value in a form is
   behaviour, and the UI has to say when nothing matched.

## Other real problems found during development

Each item is backed by the commit history or, where no commit applies, by what happened in
the session.

1. **Production build crash.** The current-user helper read the environment before
   `cookies()`, so `next build` crashed while prerendering `/dashboard` (the unit tests
   passed). Found by running the production build; fixed before committing by reading
   cookies first — the reason is documented in `src/server/auth/dal.ts` (`50f5a02`).
2. **Token expiry.** GitHub user tokens expire after 8 hours, which would have broken
   background automation. Claude noticed it from my screenshot of the new OAuth App's
   settings; fixed with refresh-token support under a row lock (`6229aae`).
3. **OAuth App naming.** Claude suggested a production OAuth App name starting with
   "GitHub", which GitHub's form rejects. Renamed to "Automation Bot" (a GitHub setting, so
   there is no commit).
4. **A test called the real GitHub API.** A test's fetch mock was installed too late and the
   error was swallowed, so it sent a real request to `api.github.com` with a fake token;
   found through a confusing assertion failure. Fixed by rewriting the test and adding a
   global guard that fails any unmocked network request (`496b49d`).
5. **A mutation check that did not apply.** Formatting had changed the target line, so a
   "passing" mutation check proved nothing; the script reported that its pattern matched 0
   times. It was re-run on the formatted code (the test then failed as expected), and
   `CLAUDE.md` now requires asserting that a mutation changed the code (`496b49d`).
6. **Worker sweep never ran on schedule.** Claude treated one manual run of the GitHub
   Actions sweeper as proof that its 5-minute schedule worked. Production testing showed 0
   scheduled runs since the workflow was added. The schedule was re-committed under my own
   GitHub identity and moved off minute 0 (`e2e2d4f`, see decision 3). **Status:
   unconfirmed** — no scheduled run had been observed when this was written. The daily
   Vercel cron (03:00 UTC) is configured but has not run yet either: the first production
   deployment was after 03:00 UTC on 2026-09-30, so its first run is due on 2026-10-01.
   Confirmed in production so far: processing right after each webhook (`after()`), and the
   `/api/cron/worker` endpoint answering correctly with the secret (one manual workflow run
   and direct calls).

## What I would improve

- **GitHub App instead of an OAuth App:** a separate bot identity, per-repository
  permissions, private repositories, and no user token in background work.
- **Automated UI tests** for the rule form — the hardest mistake above was UI behaviour
  that no automated test covered.
- **Richer rule engine:** conditions on labels, authors and branches, several actions per
  rule.
- **Better observability:** metrics and alerts (queue age, failure rate), and a check that
  the scheduled sweeper really runs.
- **Separate development database:** a Neon branch for local work (local and production
  shared one database in this project).
- **Improved AI triage:** use the suggestion as an optional, user-confirmed action.
