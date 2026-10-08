---
title: "ADR 0022: Service-client rotation-window timing residual and the secret_expired hint"
owner: identity-team
service: identity-service
status: accepted
date: 2026-10-08
diataxis: explanation
last_verified: 2026-10-08
tags: [adr, decision, service-auth, timing, rotation]
related: [service-auth-spec, adr-0018]
---

# ADR 0022 — Rotation-window timing residual and the `secret_expired` hint

- **Status:** Accepted • **Date:** 2026-10-08 • **Deciders:** identity-team

## Context

`POST /internal/auth/token` verifies the presented secret against `client_secret_hash`, and, while a rotation
window is open (`previous_secret_hash` live, up to 168 h), against the previous hash too. A wrong secret for a
client inside a window therefore costs two argon2id verifies; unknown, disabled and plain clients cost one.
Separately, when the current secret fails and the previous secret is past its expiry, the service logs the denial
reason `secret_expired` without verifying the (expired) previous hash.

## Decision

1. **Timing:** accept the difference, no code change. The caller is an authenticated-network internal client
   (internal listener, private network, 60/min per client and per IP limits), the response bodies are identical, and
   the only leak is "this client id exists and is mid-rotation", which is ops-only knowledge. Same family of
   trade-off as ADR 0018. The spec wording "one verify each" now names this exception.
2. **`secret_expired`:** keep behaviour. It is a hint meaning "wrong secret on a client whose rotation window has
   closed", not proof that the old secret was used. Alerting should use `bad_secret + secret_expired` together.

## Consequences

- An internal attacker who can already reach the listener can distinguish rotation-window clients by latency; the
  per-client and per-IP limiters bound the sampling rate.
- On-call must not treat `secret_expired` alone as a rotation fault (runbook note is handled by `/update-docs`).
- Revisit if the internal listener is ever exposed beyond the private network.
