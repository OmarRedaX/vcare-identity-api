---
title: "ADR 0017: Password reset by one-time code"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-17
diataxis: explanation
last_verified: 2026-09-17
tags: [adr, decision, auth, password-reset, otp, security]
related: [auth-spec, auth-tokens, data-model, adr-0006-email-first-registration-otp, adr-0007-transactional-outbox-worker, adr-0003-argon2id-password-hashing]
---

# ADR 0017 — Password reset by one-time code

- **Status:** Accepted • **Date:** 2026-09-17 • **Deciders:** identity-team (decision D-3, docs/auth/spec.md §14.1)

## Context
ADR 0006 made registration **email-first**: the user proves ownership of the address by typing a 6-digit code
before an account exists. Password reset was designed separately and earlier: CLAUDE.md → "Security rules"
described it as "30 minutes, 256-bit random, sha256", and the v1.0.0 `auth` spec emailed that token inside a
link (`OneTimeToken` in the contract, `password_resets.token_hash` in the data model).

That left the service with **two mechanisms for the same job** — one typed code, one emailed link — with
different tables, repository functions, contract schemas, tests, failure modes, and user journeys. It also put
a live credential **in a URL**, which is the one place a secret is hardest to keep: proxy and CDN access logs,
`Referer` headers, browser history and sync, mail-client link prefetching, and copy-pasted "here's the link"
messages all leak it, and none of those leaks is visible to us.

The question is whether reset should keep the 256-bit link token or mirror the registration challenge exactly.

## Decision
**Password reset uses a typed 6-digit one-time code, structurally identical to the registration challenge.**

- `POST /api/auth/reset-password` takes `{ email, code, newPassword }`. `email` and `code` must belong to the
  same account; nothing travels in the URL.
- `POST /api/auth/forgot-password` still always returns `204`. For a live account of **any** status it
  invalidates earlier open rows and enqueues one `send_password_reset` outbox job (ADR 0007).
- The **worker** generates the secret at send time: 6 CSPRNG digits (`crypto.randomInt`), stored only as
  `HMAC-SHA256(OTP_PEPPER, code)` hex in `password_resets.code_hash`, with `expires_at = now() + 30 minutes`.
  The plaintext exists in worker memory and the email only.
- Controls, all mirroring ADR 0006: **max 5 checked attempts** (the 5th failure sets `invalidated_at`),
  **single use** (`used_at`), **superseded** by any newer forgot-password request, **constant-time** compare,
  and limiters `forgot-email` 3/h, `reset-email` 5/h, `reset-ip` 10/h.
- Every failure mode — unknown email, wrong code, never-sent, expired, already used, superseded, or
  attempt-exhausted — returns the **identical** `400 ValidationFailed` with `details[0].field = "code"`, after
  the same work (the argon2 hash of `newPassword` always runs first; a dummy HMAC compare runs when there is
  no candidate row), so the route cannot be used to enumerate accounts.
- On success, in one transaction: the new argon2id hash is written, the row is marked `used_at`, any other open
  row is invalidated, and **all** refresh-token families are revoked (`revoked_reason='password_reset'`).
- The email carries the code and the bare `<APP_BASE_URL>/reset-password` path — no token, no query string, no
  fragment.
- `password_resets` therefore mirrors `registration_challenges`: `code_hash CHAR(64) NULL`,
  `attempts SMALLINT NOT NULL`, `expires_at`, `used_at`, `invalidated_at`, plus
  `chk_password_resets_code_sent`, `chk_password_resets_attempts (0..5)`,
  `chk_password_resets_code_hash_hex`, `chk_password_resets_single_end`. The v1.0.0
  `uq_password_resets_token_hash` unique index is **dropped**: a 6-digit code is not globally unique (two users
  may legitimately hold the same one), and the lookup is no longer by hash — reset resolves the user by email
  among live rows (`uq_users_email`), then locks that user's latest open row `FOR UPDATE`.

This extends ADR 0006's reasoning to reset; it supersedes no ADR.

## The entropy trade-off, and what bounds it
A 6-digit code carries **~20 bits** of entropy instead of the link token's **256 bits**: one blind guess has a
10⁻⁶ chance. That is only acceptable because the code is not a bearer secret in a URL — it is a credential
checked by us, against a row we control, under explicit caps:

| Control | Value |
|---|---|
| Attempts per row | 5; the 5th failure invalidates the row |
| Validity from send | 30 minutes |
| Single use | `used_at` |
| Superseded by a newer request | yes (`invalidated_at`) |
| Storage | `HMAC-SHA256(OTP_PEPPER, code)` — keyed, so a database dump alone cannot brute-force the 10⁶ space offline |
| Mint limiter | `forgot-email` 3/h per email |
| Guess limiters | `reset-email` 5/h per email (evaluated first), `reset-ip` 10/h per IP |
| Compare | `crypto.timingSafeEqual` over the hex digests |

`reset-email` is the control that makes the cap real: without it an attacker could call forgot-password to mint
fresh rows and keep guessing from many IPs. Capping guesses at 5 per hour **per email** bounds an attack on one
account to the same 5 tries the row itself allows — worst case ≈ 5×10⁻⁶ per hour — while an honest user needs
one or two. A successful guess still only reaches a password change that revokes every session and is logged
(`password_reset_completed`) and alertable.

Against that we remove an entire attack class outright: **no secret ever appears in a URL**, so there is
nothing to leak through access logs, `Referer`, history, sync, prefetching, or a forwarded link — leaks that
need no attacker interaction and that we cannot detect or rate-limit.

## Consequences
- **Contract changed** (applied as build step 0, spec §14.2): `PasswordResetCode` added, `ResetPasswordRequest`
  becomes `{ email, code, newPassword }`, `OneTimeToken` deleted, `resetPassword` and `forgotPassword`
  descriptions rewritten.
- **CLAUDE.md → Security rules** must be updated by a human (spec §12.2, items 1–2): the one-time-secret line
  for reset, and the new `reset 5/h per email` and `change-password 5/15 min per user` limiters.
- `architecture/data-model.md` and `architecture/auth-tokens.md` describe a reset **code**, not a link token;
  `uq_password_resets_token_hash` disappears.
- One mechanism to reason about: the same table shape, the same `markSent`/`recordFailedAttempt`/`markUsed`
  repository functions, the same worker handler shape, the same test matrix as registration. Every future
  change to one-time secrets (length, TTL, pepper rotation) is made in one place, twice.
- The flow works where links do not: plain-text mail clients, link-stripping gateways, and a user who reads the
  code on a phone and types it on a laptop.
- Usability cost: the user types six digits instead of clicking. `forgot-password` is already asynchronous, so
  no latency changes. The web client needs a `/reset-password` form with email + code + new password — recorded
  as platform item P-1 (spec §14.3) so the hub's web-client paths and the emailed path agree.
- Residual accepted risk: 20-bit codes are only safe while the caps hold. If `reset-email`/`reset-ip` are ever
  loosened, or the 5-attempt cap removed, this decision must be revisited — the limiters are part of the
  decision, not tuning.

## Alternatives considered

| Option | Why rejected |
|---|---|
| Keep the 256-bit emailed link token (v1.0.0) | Highest raw entropy, but puts a live credential in a URL: the leak paths (proxy/CDN logs, `Referer`, browser history and sync, mail-client prefetch, forwarded links) are invisible to us and cannot be rate-limited. Also a second mechanism to build, document, and test alongside the registration code. |
| Link token **plus** typed code (both accepted) | Doubles the attack surface and the code, and the weakest accepted path defines the security of the route. |
| 256-bit token typed by the user, not linked | Removes the URL leak but is unusable (43 characters typed from an email) with no security gain over a capped code. |
| 8-digit code (~27 bits) | Marginal gain — the caps, not the entropy, bound the attack — at a real usability cost and a divergence from the 6-digit registration code. |
| Code in a URL **fragment** (`#code=…`) | Fragments are not sent to servers, but they still land in history, sync, and shared links, and it needs a web-client contract; it buys convenience, not safety. |
| Shorter TTL (10 minutes, as registration) | Reset often happens across devices and after an inbox delay; 30 minutes is the contract's existing promise and the caps do not depend on the TTL. |
| Plain sha256 instead of HMAC with `OTP_PEPPER` | A 10⁶ space is trivially brute-forced offline from a database dump; the pepper lives outside the database, so a dump alone is useless. |
