---
title: "ADR 0003: argon2id password hashing with bcrypt legacy fallback"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-14
diataxis: explanation
last_verified: 2026-09-14
tags: [adr, decision, security, passwords, argon2]
related: [auth-tokens, service-auth, data-model]
---

# ADR 0003 — argon2id password hashing, bcrypt only to verify legacy hashes

- **Status:** Accepted • **Date:** 2026-09-14 • **Deciders:** identity-team

## Context
Identity stores credentials for every vcare user and the client secrets of every service client. PRD §11
requires "argon2/bcrypt password hashing". Login must stay under p95 250 ms **including** hashing, and
Identity must scale horizontally under credential-stuffing bursts. The platform may import accounts or
test fixtures hashed with bcrypt (the reference services use bcrypt), so those hashes must keep working
without forcing a reset.

## Decision
- Hash passwords and service client secrets with **argon2id** via the `argon2` package, parameters
  `memoryCost=19456 KiB` (19 MiB), `timeCost=2`, `parallelism=1` (the OWASP baseline). Parameters may be
  tuned **upward** only, never down; the encoded hash stores its parameters, so old hashes remain verifiable.
- **Legacy bcrypt:** a stored hash with a `$2a$`/`$2b$`/`$2y$` prefix is verified with `bcrypt`; on a
  successful login it is **rehashed with argon2id** in the same request. `bcrypt` is never used to create hashes.
- **Rehash on parameter upgrade:** when `argon2.needsRehash` reports weaker parameters than current, rehash on
  successful login.
- **Policy:** length 10..128, checked against a small breached-password denylist; no composition rules.
- **Timing:** when the email is unknown, a dummy argon2id verify runs so response time does not reveal
  account existence; unknown email and wrong password both return `401 InvalidCredentials`.
- Passwords are never logged, returned, or compared with `===`; only the library's verify functions compare.
- Login is rate-limited (5/min per IP+email, 20/min per IP) so hashing cost cannot be used for cheap DoS.

## Consequences
- ➕ Memory-hard hashing raises the cost of offline GPU/ASIC cracking far above bcrypt for the same latency.
- ➕ Legacy bcrypt users migrate transparently on their next login.
- ➕ One primitive (argon2id) for both user passwords and `service_clients.client_secret_hash`.
- ➖ ~19 MiB and tens of milliseconds per verify: login throughput per instance is bounded by CPU and
  memory; capacity planning must count concurrent logins (`LoginLatencyHigh` alert). Scaling out, not
  lowering parameters, is the response.
- ➖ Native module (`argon2` has prebuilt binaries) adds a build/runtime consideration for container images.
- ➖ Two hashing libraries remain in the dependency tree until no bcrypt hashes remain; removal needs a
  superseding ADR once a query shows zero `$2` hashes.
- ➖ Service callers must cache service tokens, since each exchange costs one argon2id verify.

## Alternatives considered
- **bcrypt only (cost 12)** — rejected: not memory-hard, 72-byte input truncation, weaker against GPU attacks
  at comparable latency.
- **scrypt** — viable and memory-hard, rejected: argon2id is the current OWASP first choice, with clearer
  parameter guidance and a well-maintained Node binding.
- **PBKDF2-SHA256** — rejected: not memory-hard; needs very high iteration counts to be competitive, which
  hurts the login budget.
- **Hosted auth (Auth0, Clerk, Cognito)** — rejected by the platform baseline: Identity owns credentials
  and account state itself.
- **Pepper (HMAC with a server-side secret before hashing)** — deferred: adds key-management and rotation
  complexity; revisit with the KMS work in [future.md](../architecture/future.md).
