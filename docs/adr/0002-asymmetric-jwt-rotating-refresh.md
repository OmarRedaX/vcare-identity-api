---
title: "ADR 0002: Asymmetric EdDSA JWTs verified via JWKS + rotating refresh tokens with reuse detection"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-14
diataxis: explanation
last_verified: 2026-09-14
tags: [adr, decision, auth, jwt, jwks, refresh-token, security]
related: [auth-tokens, service-auth, infrastructure]
---

# ADR 0002 — Asymmetric EdDSA JWTs verified locally via JWKS; rotating refresh tokens with reuse detection; bearer access + httpOnly refresh cookie

- **Status:** Accepted • **Date:** 2026-09-14 • **Deciders:** identity-team (with platform-team for the
  transport decision, hub design D2)

## Context
- PRD §4.4: Care must authorize requests **without a network call per request** — calling Identity on every
  request would make it a single point of failure for the platform.
- Multiple verifiers exist now (Identity, Care) and more are planned (Phase-2 AI service). Any verifier
  that holds a signing secret can mint tokens.
- Sessions must be long-lived for usability (30 days) but killable: suspension (Case 3) must revoke
  sessions immediately; password change/reset must end other sessions; a stolen refresh token must be
  detectable.
- One auth path is wanted for browser users, service tokens, and future non-browser clients (hub design D2).

## Decision
1. **Access tokens** are JWTs signed with **Ed25519 (`alg=EdDSA`)** using `jose`, with a `kid` header, TTL
   **15 minutes**, claims `iss, aud, sub, typ=user, role, status, ev, iat, exp, jti`. Only Identity holds
   private keys (`JWT_PRIVATE_KEYS`). Every verifier fetches public keys from
   `GET /.well-known/jwks.json` (cached 5 min) and verifies locally. Keys rotate by `kid` with an overlap
   window ([auth-tokens.md](../architecture/auth-tokens.md) → Key rotation procedure).
2. **Transport:** access token in `Authorization: Bearer` only; **refresh token** only in the
   `vcare_rt` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/api/auth`).
3. **Refresh tokens** are opaque 256-bit random values, stored as sha256, TTL 30 days, grouped in
   **families**, **rotated on every use** in one transaction. Presenting an already-rotated token revokes
   the whole family and returns `401 RefreshTokenReused`.
4. Entering `suspended`/`rejected`, password reset, admin revocation, and logout revoke refresh families;
   password change revokes all other families. Refresh re-reads the user.
5. The **residual access window** of at most 15 minutes after revocation is **accepted**; Care blocks
   suspended doctors locally at once.
6. Service tokens use the same key set with `typ=service` (hub ADR 0003).

## Consequences
- ➕ No per-request dependency on Identity: Care keeps authorizing if Identity is briefly unavailable (until
  access tokens expire), which fits Identity's Tier-1 blast radius.
- ➕ Verifiers hold only public keys; a compromised consumer cannot forge tokens.
- ➕ Adding a verifier (AI service) needs no secret distribution — just the JWKS URL.
- ➕ Ed25519 gives small tokens and fast signing/verification, helping the refresh p95 < 50 ms budget.
- ➕ Refresh rotation + reuse detection turns refresh-token theft into a detectable, self-limiting event
  (`RefreshReuseSpike` alert).
- ➕ Refresh token in an httpOnly `SameSite=Strict` cookie is unreadable by page scripts and never sent
  cross-site; the narrow `Path=/api/auth` keeps it off every other request.
- ➕ Bearer access tokens are CSRF-immune and work identically for browsers, services, and future clients.
- ➖ Access tokens cannot be revoked; suspension leaves up to 15 minutes of access (mitigated by Care's local block).
- ➖ The access token is held in browser memory and is exposed to XSS for its lifetime; mitigated by the
  short TTL, CSP via `helmet`, and never persisting it to storage.
- ➖ Claims are snapshots: role/status/`ev` changes appear only on the next refresh.
- ➖ Operational burden of key rotation and JWKS availability (`JwksUnavailable` alert).
- ➖ Concurrent refreshes from the same client with the same cookie trigger reuse detection; clients must
  serialize refresh.

## Alternatives considered
- **Symmetric HS256 with a shared secret** — rejected: every verifier (Care, AI service) would hold a secret
  that can mint tokens for any user or role; rotation needs coordinated secret redistribution; a leak in any
  service compromises the platform.
- **Opaque access tokens with an introspection call per request** — rejected: makes Identity a synchronous
  dependency of every Care request (explicitly ruled out by PRD §4.4), adds latency to every call, and
  turns an Identity blip into a platform outage. It would give instant revocation, which is the trade we
  decline in favour of a bounded 15-minute window.
- **Cookies for both access and refresh tokens** — rejected: requires CSRF defences on every state-changing
  route in both services, does not serve service-to-service or non-browser clients (two auth paths), and
  couples Care's cookie domain/path configuration to Identity's.
- **Long-lived access tokens without refresh** — rejected: no way to end sessions short of key rotation.
- **Non-rotating refresh tokens** — rejected: a stolen refresh token is usable for 30 days undetected.
- **RS256 instead of EdDSA** — viable, rejected for larger keys/signatures and slower signing with no
  interoperability need that EdDSA fails (all vcare verifiers use `jose`).
