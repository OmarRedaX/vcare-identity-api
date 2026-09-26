---
title: "ADR 0016: Auth runtime dependencies"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-17
diataxis: explanation
last_verified: 2026-09-17
tags: [adr, decision, dependencies, auth, jwt, password-hashing]
related: [auth-spec, auth-tokens, adr-0002-asymmetric-jwt-rotating-refresh, adr-0003-argon2id-password-hashing, adr-0015-foundation-runtime-dependencies]
---

# ADR 0016 — Auth runtime dependencies

- **Status:** Accepted • **Date:** 2026-09-17 • **Deciders:** identity-team

## Context
CLAUDE.md → "Tech stack (locked)" requires an ADR **before** any runtime dependency is added, and ADR 0015 set
the precedent: the foundation deliberately shipped without `jose`, `argon2`, and `bcrypt`, deferring the
justification to "the module that needs them". The `auth` module (docs/auth/spec.md) is that module. It must

- sign and verify **EdDSA (Ed25519)** access tokens with a `kid` per key and publish a JWK Set (ADR 0002),
- hash and verify passwords with **argon2id** at `memoryCost=19456, timeCost=2, parallelism=1` (ADR 0003),
- verify **legacy bcrypt** hashes so an imported account can log in once and be rehashed (CLAUDE.md →
  Security rules), and
- send email from the worker over HTTPS and parse one cookie (`vcare_rt`) on three routes.

The first three needs have no standard-library answer: Node's `crypto` can sign Ed25519 but has no JWS/JWK
implementation, no argon2, and no bcrypt. The last two do.

## Decision

1. **Add `jose` (^6) — runtime dependency.** It is the library named in CLAUDE.md → "Tech stack (locked)" for
   JWT/JWKS, supports `EdDSA` with `importJWK`/`SignJWT`/`jwtVerify` and a key-resolver callback for `kid`
   lookup, has zero dependencies, and rejects `alg: none` by design. `algorithms: ["EdDSA"]` is passed
   explicitly on every verify so algorithm confusion is impossible. Used by `lib/auth/{keys,jwt,jwks}.ts`, and
   later by Epic B for service tokens.
2. **Add `argon2` (^0.45) — runtime dependency, native.** argon2id is mandated by ADR 0003 and CLAUDE.md →
   "Tech stack (locked)"; `argon2` exposes `hash`, `verify`, and `needsRehash(stored, params)`, which is what
   lets login upgrade a hash whose parameters have since been raised. It is a native module with prebuilt
   binaries for Node 24, built in the Dockerfile's existing `prod-deps` stage so the runtime image keeps no
   toolchain. Hashing runs on the libuv threadpool, so `HASH_CONCURRENCY` above 4 needs `UV_THREADPOOL_SIZE`
   raised in the task definition (documented, not validated).
3. **Add `bcrypt` (^6) — runtime dependency, native, verify-only.** CLAUDE.md → "Tech stack (locked)" allows
   bcrypt **only** to verify legacy hashes, then rehash. `lib/password/password-hasher.ts` therefore calls
   `bcrypt.compare` for a stored hash starting `$2a$`/`$2b$`/`$2y$` and **never** `bcrypt.hash`; a successful
   bcrypt verify always sets `needsRehash = true`, so the row is rewritten with argon2id in the same login
   transaction. No code path can create a new bcrypt hash.
4. **Add `@types/bcrypt` — dev dependency only** (`jose` and `argon2` ship their own types).
5. **No cookie parser.** One cookie, three routes, no signing, no encoding beyond `decodeURIComponent`:
   `lib/http/cookies.ts` is ~30 lines, unit-tested, and emits the exact `Set-Cookie` strings the contract
   documents. `cookie-parser` would be an extra runtime dependency for a `String.split`.
6. **No Resend SDK and no HTTP client.** The email adapter is one `POST /emails` with a bearer key; Node 24's
   global `fetch` plus `AbortSignal.any([signal, AbortSignal.timeout(5000)])` covers it. `node-fetch` and
   `axios` are already blocked by the ESLint `no-restricted-imports` rule.
7. **The breached-password denylist is committed data, not a dependency.** `lib/password/denylist.ts` is
   generated once by `scripts/build-password-denylist.ts` from SecLists
   (`Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt`, MIT), lower-cased and filtered to
   10..128 characters; the generated file records source URL, commit SHA, and licence in its header.

Versions are pinned to a major (`^`) and recorded in `package.json`; the lockfile is the exact record.

## Consequences

- The deployable image gains **two native modules**. `npm ci` must find prebuilt binaries for linux/arm64 on
  Node 24 in the `prod-deps` stage; if a build ever falls back to source compilation, that stage needs
  `python3`/`make`/`g++` — the runtime stage must still contain none of them. CI failures here are build
  failures, not runtime failures.
- Password hashing is CPU-bound work inside the API process. It is bounded by the semaphore
  (`HASH_CONCURRENCY`, `HASH_QUEUE_MAX`) and answers `429 RateLimited` rather than queueing without limit, and
  argon2 never runs while a transaction or pooled connection is held (spec §3.8).
- `bcrypt` exists only to retire itself. Once no `$2` hash remains in `users.password_hash` (verifiable with a
  single query), a superseding ADR removes the dependency and the branch in `password-hasher.ts`.
- `jose` is shared with Epic B (service tokens) and mirrors care-service, which verifies the same tokens
  against our JWKS — one JOSE implementation across the platform.
- Private key material stays in `JWT_PRIVATE_KEYS` and is never logged, stored, or published; `jose` only ever
  receives it through `importJWK` at boot.

## Alternatives considered

| Option | Why rejected |
|---|---|
| `jsonwebtoken` | Forbidden by CLAUDE.md → "Tech stack (locked)"; no JWK Set support, historically weak `alg` handling. |
| Hand-rolled JWS over `node:crypto` | We would own base64url framing, claim validation, `kid` resolution, and clock tolerance — security-critical code with no upside over a zero-dependency library. |
| `@node-rs/argon2` | Technically viable and often faster, but care-service will hash nothing while Identity owns passwords; parity with the locked list (`argon2`) matters more than throughput we can buy with `HASH_CONCURRENCY`. |
| `bcryptjs` (pure JS) instead of `bcrypt` | Avoids a native module but is markedly slower per verify and would be a second hashing implementation to retire. The legacy path is rare, so native + prebuilt is the smaller cost. |
| Refuse bcrypt entirely (force reset for legacy accounts) | Reasonable for a green-field service, but CLAUDE.md → Security rules explicitly requires verify-then-rehash, and forcing a reset would email every imported user. |
| `resend` SDK | An extra runtime dependency, its own transitive tree, and its own retry semantics, for a single `POST` whose error mapping we must own anyway (retryable vs dead, spec §5.5). |
| `cookie-parser` | Adds middleware and a dependency for one cookie; we need exact control over `HttpOnly; Secure; SameSite=Strict; Path=/api/auth` strings regardless. |
| An online breached-password API (e.g. k-anonymity range queries) | An outbound network call on the registration and reset request paths — forbidden by spec §1.2 (no outbound call on any request path) and a new availability dependency. |
