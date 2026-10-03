---
title: Identity Service — Runtime, Bottlenecks and Observability
owner: identity-team
service: identity-service
status: accepted
diataxis: explanation
last_verified: 2026-10-02
tags: [architecture, runtime, scaling, slo, disaster-recovery, bottlenecks, observability]
related: [system-design, design-baseline, capacity, overview, infrastructure, runbook, adr-0007-transactional-outbox-worker, adr-0008-redis-tier-2-fallback-limiter, adr-0009-availability-and-recovery-targets, adr-0013-log-derived-metrics, adr-0014-health-liveness-readiness-split, hub-deployment]
---

# Runtime, Bottlenecks and Observability — identity-service

Identity's side of the runtime architecture (stages 5 and 6 of the 2026-09-15 system design). Service-scope
(hub ADR 0008). The **platform deployment topology** is authored in the hub
([`../vcare-hub/architecture/deployment.md`](../../../vcare-hub/architecture/deployment.md)): the edge routing
table, private network, every service's components, the availability roll-up, the release pipeline, and
cross-service observability. Decisions behind it: hub ADR 0005 (edge) and ADR 0007 (managed containers). Sizing:
[capacity.md](./capacity.md). The hub roll-up quotes this doc's component counts and targets; update it when they
change.

## 1. Identity's runtime components

Secrets these components load: `JWT_PRIVATE_KEYS`, `OTP_PEPPER`, `DATABASE_URL`, `REDIS_URL`, the email provider
key. Postgres runs as a primary with a synchronous standby in a second AZ plus PITR; Redis runs as a primary with a
replica (Tier 2).

| Component | Image / entrypoint | Count | Scaling | Health used |
|---|---|---|---|---|
| `identity-api` | one image, `node dist/server.js` (both listeners) | min 2, max 6, spread across AZs | target CPU 60 %; step on login p95 > 200 ms | LB: `/api/health/ready` and `/internal/health/ready`; orchestrator: `/api/health/live` |
| `identity-worker` | same image, `node dist/worker.js` | 1 (2 when outbox lag alert fires repeatedly) | manual | orchestrator: process liveness |
| `identity-migrate` | same image, `node dist/migrate.js latest` (a bare `node dist/migrate.js` exits 1) | one-off per release | — | exit code |

The image (as built, `Dockerfile`) is `node:24-alpine`, runs as the non-root `node` user, exposes 3000 and 3100,
defaults to `node dist/server.js`, and has no `HEALTHCHECK` (the orchestrator probes HTTP). Container settings
the tasks need: `INTERNAL_HOST` set to the task's private interface (the default `127.0.0.1` would make the
internal LB and `/internal/health/ready` unreachable), and `TRUST_PROXY_HOPS` equal to the proxy hops in front of
the task (hub `deployment.md` → edge path) so rate-limit subjects use the real client IP.

Network rules: the public LB target group exposes only `:3000`; `:3100` is reachable only through the
internal LB from care-api's security group (and future registered service clients); Postgres and Redis
accept only identity task security groups; the worker is the only component with egress to the email
provider; identity-api has **no internet egress** (it makes no outbound calls).

## 2. Availability and recovery (ADR 0009)

Authored here and quoted in the hub's platform availability roll-up.

| Target | Value | Mechanism |
|---|---|---|
| Availability | **99.95 % monthly** (≈ 22 min) | ≥ 2 tasks in ≥ 2 AZs; readiness-gated LB; rolling deploys |
| RPO — AZ failure | 0 | synchronous standby |
| RPO — logical corruption / bad migration | ≤ 5 min | point-in-time recovery |
| RTO — task/AZ failure | ≤ 5 min | orchestrator reschedules; managed DB failover (~1–2 min) |
| RTO — region loss | ≤ 4 h | restore encrypted snapshot copy in the second region, redeploy IaC there |
| Backups | daily snapshots 35 d + PITR; cross-region copy | quarterly restore drill |

Redis is **Tier 2** (ADR 0008): its loss degrades rate limiting and idempotency but never makes Identity
unavailable. The email provider is Tier 2 via the outbox.

## 3. Release specifics

The pipeline itself is platform-wide and authored in the hub (`deployment.md` → Release pipeline): CI gates,
immutable image tagged with the commit SHA, one-off migration task, **expand → migrate → contract**, rolling deploy,
rollback to the previous task definition. Identity's specifics:

1. Migration task: `identity-migrate`, before any rollout.
2. Rollout order: `identity-api` (minimum healthy 100 %, maximum 200 %), then `identity-worker`.
3. Post-deploy smoke: `GET /.well-known/jwks.json` non-empty, readiness 200, synthetic login + refresh on a
   synthetic account.

Signing-key and client-secret rotations follow [runbook.md](../runbook.md) and are config deploys.

## 4. Expected bottlenecks and mitigations

| # | Bottleneck | Why it hurts | Software mitigation | DevOps / infrastructure mitigation |
|---|---|---|---|---|
| 1 | **argon2 CPU/memory** on login, register/complete, reset, change, service token | ~50 ms CPU + 19 MiB per hash; libuv pool defaults to 4 threads; a burst queues and breaks login p95 < 250 ms | bounded **hash semaphore** (`HASH_CONCURRENCY` = vCPU, `HASH_QUEUE_MAX`); full queue → `429 RateLimited` + `Retry-After`, never unbounded wait; dummy verify goes through the same semaphore | autoscale on CPU and login p95; alert `LoginLatencyHigh`; **never lower argon2 parameters** |
| 2 | **Credential stuffing** (~500 attempts/s design point) | every attempt that reaches argon2 burns CPU; distributed IPs evade per-IP limits | limiter middleware runs **before** body validation and hashing; IP+email and IP limiters; D6 fallback limiter when Redis is down | WAF rate-based rules on `/api/auth/login`, `/api/auth/register/*`, `/api/auth/forgot-password`; managed bot control; alert `AuthFailureSpike` |
| 3 | **`refresh_tokens` churn** (160 k inserts + updates/day, 5–10 M rows) | table/index bloat, autovacuum lag, slower refresh p95 | worker purge in **batches of 5 k rows with sleeps** under an advisory lock; partial indexes on live rows keep hot paths small | per-table autovacuum tuning (`autovacuum_vacuum_scale_factor=0.02`, `autovacuum_analyze_scale_factor=0.01`); monitor dead tuples; at 10× adopt monthly partitions (new ADR) |
| 4 | **Postgres connections and failover** | pool exhaustion under load; Multi-AZ failover drops connections ~60 s | pool per task (`DATABASE_POOL_MAX`), 2 s statement timeout, fast-fail on pool wait > 1 s, reconnect; retries only for idempotent reads | no connection proxy at this scale (add one past ~10 tasks); quarterly failover drill; alert on pool wait time |
| 5 | **`/internal/users` fan-in** from Care search spikes | cache misses in Care hit Identity together | single `= ANY($1)` PK query, ≤ 100 ids, no outbound calls, no Redis on the path | Care's 300 s cache absorbs ~80 %; internal LB isolates internal traffic from public; alert `InternalUsersLatencyHigh` |
| 6 | **JWKS availability** | Care re-fetches the key set every 5 min; if it can't for > 1 h (its stale-if-error cap), every Care request fails — and a token signed with a new `kid` fails as soon as the outage starts | JWKS built once at boot, served from memory | edge caches `/.well-known/jwks.json` (`max-age=300`); synthetic probe alert `JwksUnavailable`; JWKS survives origin blips from edge cache |
| 7 | **Outbox lag / email provider slowness** | registration codes arrive late (10 min TTL) and users abandon sign-up | claim 20 jobs with `FOR UPDATE SKIP LOCKED`; provider call timeout 5 s; exponential backoff; `dead` after 8 attempts; code TTL starts **at send time** | alert when oldest pending job > 2 min; scale worker to 2; secondary email provider is a follow-up |
| 8 | **Deploys and migrations** | a breaking migration mid-rollout causes 500s on old tasks | expand → migrate → contract; migrations reviewed with the `write-migration` skill | migration task before rollout; rolling deploy with 100 % min healthy; rollback = previous task definition |
| 9 | **Redis failover** | brief loss of shared limits and idempotency | per-instance fallback limiter (stricter), DB constraints for duplicate registration (ADR 0008) | managed Redis with replica + automatic failover; alert `RateLimiterDegraded` |
| 10 | **Dependency-coupled health checks** | readiness failing on Redis would drain all tasks at once | liveness = process only; readiness = Postgres only, Redis reported as `degraded` (ADR 0014); readiness `503` during shutdown drain | LB uses readiness, orchestrator restarts on liveness only |

## 5. Observability (ADR 0013)

**Signals.** The structured JSON logger emits request logs (existing fields) and **metric events in the
embedded metric format** (e.g. CloudWatch EMF) — no new dependency. `X-Request-Id` links Care and Identity
logs; `user_status_changes.request_id` persists it for status changes.

As built (2026-09-16), `logger.metric()` exists and emits `rate_limited` and `rate_limiter_degraded`; the other
metrics below arrive with their modules.

| Metric | Dimensions | Used by |
|---|---|---|
| `http_requests` count, `http_latency_ms` (p50/p95/p99), `http_errors` by `code` | `route`, `status` | RED dashboards, latency SLO alerts |
| `hash_queue_depth`, `hash_rejected` | — | bottleneck 1 |
| `login_failed`, `rate_limited` | `limiter` | `AuthFailureSpike` |
| `refresh_token_reuse_detected`, `refresh_token_grace_reuse` | — | `RefreshReuseSpike`; grace-window health |
| `rate_limiter_degraded` | `limiter` | `RateLimiterDegraded` |
| `outbox_oldest_pending_age_s`, `outbox_dead_jobs` | `type` | `OutboxLagHigh`, `OutboxDeadJobs` |
| `db_pool_wait_ms`, `db_pool_in_use` | — | bottleneck 4 |
| `service_token_denied` | `reason` | caller misconfiguration |

**Alerts (added to the runbook set):** `LoginLatencyHigh`, `RefreshReuseSpike`, `AuthFailureSpike`,
`InternalUsersLatencyHigh`, `JwksUnavailable`, `HealthCheckFailing` (existing) plus `OutboxLagHigh`
(oldest pending > 2 min for 5 min), `OutboxDeadJobs` (> 0), `RateLimiterDegraded` (any for 2 min),
`DbPoolSaturated` (wait p95 > 200 ms for 5 min), `AvailabilityBudgetBurn` (5xx + readiness failures burning
the 99.95 % budget at > 2× rate over 1 h).

## 6. New configuration introduced by this baseline

| Variable | Secret | Default | Purpose |
|---|---|---|---|
| `OTP_PEPPER` | yes | — | HMAC key for registration codes (ADR 0006) |
| `REFRESH_REUSE_GRACE_SECONDS` | no | `10` (max 30) | refresh grace window (ADR 0005) |
| `RATE_LIMIT_FALLBACK_DIVISOR` | no | `2` | per-instance fallback limit = max(1, floor(limit / divisor)) (ADR 0008) |
| `HASH_CONCURRENCY` | no | vCPU count | argon2 semaphore size |
| `HASH_QUEUE_MAX` | no | `50` | queued hashes before `429` |
| `WORKER_POLL_INTERVAL_MS` | no | `1000` | outbox polling interval (ADR 0007) |
| `WORKER_BATCH_SIZE` | no | `20` | jobs claimed per poll |
| `OUTBOX_MAX_ATTEMPTS` | no | `8` | attempts before `dead` |

All go into the zod env schema (`src/lib/config/env.schema.ts`) when the modules are built; secrets have no
defaults. As of 2026-09-16 the `foundation` module has added `RATE_LIMIT_FALLBACK_DIVISOR` and
`WORKER_POLL_INTERVAL_MS` from this table, plus `TRUST_PROXY_HOPS` (default `0`), `SHUTDOWN_TIMEOUT_MS`, and the
base variables. Full list and status per variable: [infrastructure.md](./infrastructure.md) → Environment variables.

## 7. Deferred

Monthly partitioning of `refresh_tokens` (at 10×) · connection proxy (past ~10 tasks) · secondary email
provider · OpenTelemetry traces (ADR 0013). Platform-wide deferrals (multi-region, Kubernetes, joint tracing) are
in the hub `architecture/deployment.md` → Deferred.
