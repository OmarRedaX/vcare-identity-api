---
title: "ADR 0007: Postgres transactional outbox and a separate worker process"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, async, outbox, worker, email, background-jobs]
related: [design-baseline, deployment, data-model, infrastructure, adr-0006-email-first-registration-otp]
---

# ADR 0007 — Postgres transactional outbox and a separate worker process

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** identity-team

## Context
CLAUDE.md requires email sending and token cleanup to run outside the request, but no mechanism existed: no
message bus in MVP, and any new runtime dependency needs an ADR. Emails carry secrets (registration codes,
reset tokens) that must never be stored in plaintext. A job must not be sent for a transaction that rolled
back, and must survive deploys and crashes. Multiple API replicas must not run scheduled purges concurrently.

## Decision
- **Outbox table `outbox_jobs`** (`type`, `aggregate_id`, `status`, `attempts`, `run_after`, `locked_until`,
  `last_error`, `request_id`, timestamps). Request code inserts the job **in the same transaction** as the
  business write. Rows hold ids only — no PII, no secrets.
- **Worker** = `src/worker.ts` in the same codebase and image, deployed as its own service. It claims jobs with
  `UPDATE … WHERE id IN (SELECT id … WHERE status='pending' AND run_after <= now() ORDER BY run_after LIMIT $n FOR UPDATE SKIP LOCKED)`,
  sets a lease (`locked_until`), and re-claims `processing` jobs whose lease expired.
- **Secrets are generated at send time** by the worker (registration code, reset token): it writes the hash and
  `expires_at` onto the aggregate row and sends the plaintext only to the email provider, in memory.
- Retries with exponential backoff; `dead` after `OUTBOX_MAX_ATTEMPTS` (8); `last_error` records an error class,
  never provider bodies.
- **Scheduled purges** (expired/revoked tokens, challenges, finished jobs) run in the worker under
  `pg_try_advisory_lock`, in batches.
- The outbox is the intended carrier for future events (`user.status_changed`), superseding nothing today.

## Consequences
- ➕ No new dependency; durable and transactional; email slowness never touches API latency.
- ➕ One pattern for email now and events later.
- ➖ One more deployable, and polling load on Postgres (small, served by a partial index).
- ➖ Delivery is at-least-once: an email may be sent twice after a crash between send and commit; a second code
  or reset token simply supersedes the first.

## Alternatives considered
- **BullMQ on Redis** — mature features, rejected: new dependency, dual write (Postgres then Redis), and Redis
  would hold durable state while being Tier 2 (ADR 0008).
- **In-process fire-and-forget + node-cron** — rejected: emails lost on deploy/crash, purges run per replica,
  and email work competes with login CPU.
