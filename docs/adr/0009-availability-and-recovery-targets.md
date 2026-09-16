---
title: "ADR 0009: Availability 99.95 %, single region multi-AZ, RPO/RTO targets"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, slo, availability, disaster-recovery, backups]
related: [design-baseline, deployment, capacity, runbook]
---

# ADR 0009 — Availability 99.95 %, single region multi-AZ, RPO/RTO targets

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** identity-team

## Context
Identity is Tier 1 — if it is down nobody can log in or refresh — but no availability, data-loss, or recovery
targets existed, so topology and cost could not be reasoned about. care-service also runs in a single region;
platform availability is bounded by its weakest Tier-1 component.

## Decision
| Target | Value |
|---|---|
| Availability | **99.95 % monthly** (≈ 22 min budget) |
| RPO | 0 for AZ failure · ≤ 5 min for logical corruption |
| RTO | ≤ 5 min for task/AZ failure · ≤ 4 h for region loss |

Mechanisms: ≥ 2 `identity-api` tasks across ≥ 2 AZs; managed PostgreSQL with a **synchronous standby** in a
second AZ and automatic failover; point-in-time recovery; daily encrypted snapshots retained 35 days and copied
to a second region; quarterly restore and failover drills. Redis and the email provider are Tier 2
(ADR 0008, ADR 0007) and do not count against the budget.

## Consequences
- ➕ Credible Tier-1 promise at moderate cost; matches what Care can deliver.
- ➕ Clear inputs for alerting (`AvailabilityBudgetBurn`) and for release policy.
- ➖ A full region loss is hours of downtime (accepted for MVP; rare).
- ➖ Synchronous standby adds a small write-latency cost (inside the refresh budget) and roughly doubles DB cost.

## Alternatives considered
- **99.9 %, single-AZ primary + async replica** — cheapest; rejected: one AZ incident can consume the month and
  a failover can lose recent writes (refresh rotations).
- **99.99 %, multi-region active-passive** — rejected for MVP: ~2× infrastructure and drills, and buys nothing at
  platform level unless Care goes multi-region too.
