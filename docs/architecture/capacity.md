---
title: Identity Service — Capacity Estimation
owner: identity-team
service: identity-service
status: accepted
diataxis: explanation
last_verified: 2026-09-15
tags: [architecture, capacity, sizing, performance, storage]
related: [system-design, design-baseline, deployment, data-model, adr-0003-argon2id-password-hashing, hub-capacity]
---

# Capacity Estimation — identity-service derivation

Derives identity-service's load and sizing from the **platform capacity model in the hub**
([`../vcare-hub/architecture/capacity.md`](../../../vcare-hub/architecture/capacity.md)), whose shared
assumptions were chosen in this repo's `/system-design` on 2026-09-15 (decision D12). This is a service-scope doc
(hub ADR 0008). Platform inputs are authored in the hub — change them there, then re-derive here. The hub's sizing
roll-up quotes this doc's headlines (section 3–5); update that row whenever a headline here changes. The design
must hold at **10×** without redesign (section 7).

## 1. Inputs

**Platform inputs — authored in the hub** (quoted, do not edit here): 500 k registered (≈ 2.5 k doctors) · 50 k
DAU · ≈ 900 new accounts/day · peak hour 15 % of daily traffic with ×2 burst · campaign login spike ×5 · hostile
design point ~500 login attempts/s · **~100 k** Case-2 lookups/day reaching Identity after Care's cache.

**Identity-specific inputs — authored here:**

| Input | Value | Rationale |
|---|---|---|
| Refreshes per DAU per day | 3 | page load + ~1 per 15-min access TTL while the app is open |
| Logins per DAU per day | 0.2 | 30-day sliding refresh makes logins rare |
| `/auth/me` per DAU per day | 3 | app load |
| Registration calls | ≈ 2 k start+complete calls/day | ≈ 900 new accounts/day plus retries |
| Password resets | ≈ 500/day | ~1 % of DAU |

Peak rps = daily × 0.15 / 3600 × 2 (hub formula).

## 2. Request load

| Endpoint | Per day | Peak rps | Unit cost |
|---|---|---|---|
| `POST /api/auth/refresh` | 150 k | **~12** | ~5 SQL statements (1 lookup, 1 user read, txn with 1 insert + 1 update) + 1 EdDSA sign |
| `GET /api/auth/me` | 150 k | ~12 | 1 PK read (or token-only) |
| `GET /internal/users` | 100 k | ~9 (20–50 ids each) | 1 `id = ANY($1)` PK query |
| `POST /api/auth/login` | 10 k | ~1 normal, **~5 campaign** | **argon2id verify ≈ 50 ms CPU, 19 MiB** |
| `register/start` + `register/complete` | ~2 k | < 1 | complete: 1 argon2id hash + 1 txn |
| forgot/reset/change password | ~1 k | < 1 | argon2id on reset/change |
| JWKS, service token, status changes | small | < 1 | JWKS from memory/CDN; token = 1 argon2id verify per 270 s per caller task |
| **Total legitimate** | ~0.5 M | **~40–50 rps** | |

## 3. Compute

- **argon2 CPU:** 5 logins/s × 50 ms ≈ **0.25 core** at campaign peak. Legitimate load is dominated by I/O.
- **Hostile load:** per-IP limits (20/min) still allow a 1,000-IP botnet ≈ 330 hashes/s ≈ 17 cores. That is
  why the design relies on **edge WAF rate/bot rules first**, then a **bounded hash semaphore** that sheds
  with `429` rather than queueing ([deployment.md](./deployment.md) → bottleneck 1–2).
- **Hash memory:** hash concurrency per task × 19 MiB (2 × 19 MiB ≈ 38 MiB at `HASH_CONCURRENCY=2`).
- **Tasks:** `identity-api` 2 × (1 vCPU, 2 GB) — the floor is set by multi-AZ availability, not CPU;
  autoscale to 6. `identity-worker` 1 × (0.5 vCPU, 1 GB).

## 4. Database

| Metric | Value |
|---|---|
| Peak queries/s | ~100 (refresh ≈ 60, me ≈ 12, internal ≈ 9, rest small) |
| Peak writes/s | ~30 (refresh rotation dominates) |
| Connections | 2 API tasks × pool 10 + worker 5 + migration task 2 ≈ **27** |
| Instance | 2 vCPU / 8 GB class, Multi-AZ synchronous standby |

### Storage

| Table | Rows (steady state) | Size incl. indexes | Driver |
|---|---|---|---|
| `users` | 500 k | ≈ 0.5 GB | ~1 KB/row |
| `refresh_tokens` | **≈ 5–10 M** | **≈ 6 GB** | 160 k new rows/day (refresh + login) kept ~30 d after revocation/expiry; ~600 B/row with 4 indexes |
| `user_status_changes` | < 50 k | < 20 MB | doctor verification + suspensions |
| `password_resets` | ≈ 15 k | < 10 MB | 30-day retention |
| `registration_challenges` | ≈ 2 k | < 1 MB | 24 h retention |
| `outbox_jobs` | ≈ 20 k | < 20 MB | ~3 k jobs/day, `done` kept 7 d |
| `service_clients` | < 10 | — | |
| **Total** | | **≈ 7 GB** | provision **50 GB** with storage autoscaling; PITR + snapshots extra |

`refresh_tokens` is the largest and highest-churn table (insert + update per refresh) — see
[deployment.md](./deployment.md) → bottleneck 3.

## 5. Redis (Tier 2)

| Use | Size |
|---|---|
| Sliding-window rate-limit keys | thousands of short-TTL keys at peak, < 10 MB |
| Idempotency records (24 h) | ~1 k/day × ~2 KB ≈ 2 MB |
| **Instance** | smallest managed node with a replica (< 256 MB used) |

## 6. Network

Responses < 2 KB; ~50 rps × 2 KB ≈ 100 KB/s. Negligible; the edge/WAF is sized by request count, not bytes.

## 7. 10× check (5 M registered / 500 k DAU)

| Dimension | At 10× | Still no redesign? |
|---|---|---|
| Legit peak | ~450 rps; logins ~50/s campaign (≈ 2.5 cores argon2) | yes — scale `identity-api` to 4–8 tasks |
| Postgres | ~1 k qps, ~300 writes/s, ~100 conns | yes — 4–8 vCPU; add a connection proxy past ~10 tasks |
| `refresh_tokens` | ~60 M rows / ~60 GB | yes, with **monthly partitioning** (drop partitions instead of purge) — needs its own ADR then |
| `/internal/users` | ~90 rps | yes — PK lookups |
| Redis | < 1 GB | yes |

## 8. Revisit triggers

Re-run this estimate when any of these is observed for a week: `refresh_tokens` > 30 M rows · login p95 > 200 ms
at peak · Postgres CPU > 60 % at peak · outbox oldest-pending age > 2 min daily. Platform-wide triggers (DAU,
registered users, hydration volume) live in the hub capacity model and also force a re-derivation here.
