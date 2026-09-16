---
title: "ADR 0005: 10-second grace window for concurrent refresh"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-15
tags: [adr, decision, auth, refresh-token, sessions]
related: [design-baseline, auth-tokens, adr-0002-asymmetric-jwt-rotating-refresh, runbook]
---

# ADR 0005 — 10-second grace window for concurrent refresh

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** identity-team

## Context
ADR 0002 rotates the refresh token on every use and revokes the whole family when a rotated token is
presented again. Browsers share one cookie jar across tabs: two tabs refreshing at the same moment send the
same token; the loser sees `revoked_reason='rotated'` and today triggers reuse detection, logging the user out
everywhere. This is normal use, not an attack, and would also make the `RefreshReuseSpike` alert noisy.

## Decision
- When the presented token has `revoked_reason='rotated'`, `revoked_at > now() - REFRESH_REUSE_GRACE_SECONDS`
  (default **10 s**, max 30), **and its successor (`replaced_by_id`) is still live (not itself rotated or
  revoked)**, return `401 RefreshTokenInvalid`, **do not revoke the family**, and **send no clearing
  `Set-Cookie`** (the shared cookie jar already holds the successor; clearing it would log every tab out).
  Emit `refresh_token_grace_reuse`. This is the only `401` on refresh that does not clear the cookie.
- Outside those conditions the existing rule applies: revoke the family (`reuse_detected`), `401 RefreshTokenReused`.
- Client contract (web app): single-flight refresh across tabs with the Web Locks API; on `RefreshTokenInvalid`
  retry **once** (the browser now sends the successor cookie); if the retry also fails, call
  `POST /api/auth/logout` (which revokes the presented token's family) before showing the login screen.
- No schema change: the rule uses `revoked_at`, `revoked_reason`, `replaced_by_id`.

## Consequences
- ➕ Multi-tab and flaky-network double submits no longer log users out; reuse alerts keep their signal.
- ➕ Refresh remains one indexed lookup plus a PK read; p95 < 50 ms holds; no Redis on the refresh path.
- ➖ A thief replaying a stolen token within 10 s of a legitimate rotation does not trigger revocation (but gets
  no token). If the thief rotated first, the victim's retry fails, the client's logout revokes the family, and
  the thief's session dies; after 10 s any replay revokes the family as before.
- ➖ Correctness depends partly on the client following the retry-then-logout rule.

## Alternatives considered
- **Grace window that replays the successor tokens** from an encrypted Redis entry — seamless, rejected: puts
  Redis (Tier 2) on the refresh path and caches key material.
- **Client-side single-flight only** — rejected: any client bug, older browser, or future mobile client causes
  mass logouts.
