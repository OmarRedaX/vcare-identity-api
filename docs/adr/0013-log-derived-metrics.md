---
title: "ADR 0013: Log-derived metrics (embedded metric format); no tracing SDK in MVP"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, observability, metrics, logging, alerts]
related: [deployment, infrastructure, runbook, adr-0009-availability-and-recovery-targets]
---

# ADR 0013 — Log-derived metrics (embedded metric format); no tracing SDK in MVP

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** identity-team

## Context
The bottlenecks identified in [deployment.md](../architecture/deployment.md) (argon2 queueing, outbox lag,
reuse spikes, limiter degradation, pool saturation) need metrics and alerts, and the 99.95 % target needs an
error-budget signal. The service already has a custom structured JSON logger and propagates `X-Request-Id`
across services. Any new runtime dependency requires an ADR.

## Decision
- The existing `Logger` gains a `metric(name, value, unit, dimensions)` method that writes one JSON line in the
  platform's **embedded metric format** (e.g. CloudWatch EMF) to stdout. No new dependency; metric lines follow
  the same redaction rules (dimensions never hold PII, tokens, or emails).
- Metrics and alerts are the set in [deployment.md](../architecture/deployment.md) → Observability.
- Cross-service tracing is by `X-Request-Id` (logs of both services; `user_status_changes.request_id`).
- OpenTelemetry tracing is deferred; adopting it later is a joint Identity + Care ADR.

## Consequences
- ➕ Zero dependencies and no collector to operate; cheap at MVP scale.
- ➕ One pipeline (stdout) for logs and metrics; metrics share request context.
- ➖ No per-request span breakdown (DB vs hash vs sign); latency debugging uses request-id log search and `EXPLAIN`.
- ➖ The metric format is tied to the chosen platform's log ingestion (hub ADR 0007); switching platforms changes
  the formatter, not call sites.

## Alternatives considered
- **OpenTelemetry SDK + collector** — real distributed traces; rejected for MVP: several dependencies, a collector
  to run, and both services must adopt together.
- **Prometheus client + managed Prometheus/Grafana** — rejected: new dependency and scrape plumbing on managed
  containers, still no traces.
