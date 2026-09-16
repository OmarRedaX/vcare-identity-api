---
title: "ADR 0015: Foundation runtime dependencies"
owner: identity-team
service: identity-service
status: accepted
date: 2026-09-15
diataxis: explanation
last_verified: 2026-09-16
tags: [adr, decision, dependencies, foundation, tooling]
related: [foundation-spec, foundation-brainstorm, infrastructure, adr-0013-log-derived-metrics, adr-0014-health-liveness-readiness-split]
---

# ADR 0015 — Foundation runtime dependencies

- **Status:** Accepted • **Date:** 2026-09-15 • **Deciders:** identity-team

## Context
CLAUDE.md → "Tech stack (locked)" requires an ADR in `docs/adr/` **before** any runtime dependency outside the
locked list is added. The `foundation` module (docs/foundation/spec.md) is the first code in the repo, so it is
the first place where that question is answered concretely: it needs DI decorators, a CORS allowlist for local
development, request ids, and environment files, and each of those has a popular package that we would otherwise
reach for out of habit.

The locked stack already covers HTTP (`express`), validation (`class-validator` + `class-transformer`), env
parsing (`zod`), DI (`tsyringe`), database (`knex` + `pg`), Redis (`ioredis`), and security headers (`helmet`).
Four gaps remain.

## Decision

1. **Add `reflect-metadata` (runtime dependency).** `tsyringe` decorators (`@injectable`, `@inject`) require the
   `Reflect.metadata` polyfill; it is the documented, mandatory peer of the locked DI library, not a new
   capability. It is imported exactly once per entrypoint, as the **first** line of `src/server.ts`,
   `src/worker.ts`, `src/migrate.ts`, and `tests/setup.ts`.
2. **No `cors` package.** CORS is development-only (hub ADR 0005: production is a single origin with CORS
   disabled), the allowlist is exact-string matching, and the whole middleware is ~30 lines in
   `src/lib/http/cors.ts` — fully under our control and unit-tested.
3. **No `uuid` package.** Node 24 ships `crypto.randomUUID()`, which is what `lib/request-id` and the tests use.
4. **No `dotenv` package.** Node 24 ships `--env-file-if-exists` (used by the `dev`, `migrate`, … scripts) and
   `process.loadEnvFile()` (used by `tests/setup.ts`). Environment values in the real environment always win
   over file values, so container and CI configuration is unaffected.
5. **`tsx` stays a dev dependency only.** It is the local runner and migration CLI driver. Because esbuild does
   **not** emit decorator metadata, no class may rely on type-based auto-injection: **every** constructor
   parameter of an `@injectable()` class carries an explicit `@inject(TOKENS.X)`.

No other runtime dependency is added by the foundation. `jose`, `argon2`, and `bcrypt` remain absent until the
module that needs them lands (each with its own justification against the locked list).

## Consequences

- The dependency surface of the first deployable image is nine runtime packages plus `reflect-metadata`; the
  production image contains no build toolchain (the `prod-deps` Docker stage exists so a future native build of
  `argon2` never reaches the runtime image).
- We own the CORS middleware: a bug there is ours to fix, and any future need (wildcards, per-route origins)
  is a code change rather than a configuration change. Accepted because the behaviour is dev-only and tiny.
- Explicit `@inject` on every constructor parameter is a standing review item; a missing decorator fails at
  container resolution, not at compile time.
- `tsx` is never used to run production code — production runs `node dist/*.js` built by `tsc`.

## Alternatives considered

| Option | Why rejected |
|---|---|
| `cors` package | An extra runtime dependency and supply-chain surface for behaviour that is disabled in production. |
| `uuid` package | Redundant with the platform's `crypto.randomUUID()`. |
| `dotenv` | Redundant with Node's native env-file support; also tempts `.env` loading in production images. |
| `ts-node` instead of `tsx` | Slower start-up for `dev` and the migration CLI; still only a dev tool, so it buys nothing. It does emit decorator metadata, but explicit `@inject` tokens make that irrelevant. |
| Drop `tsyringe` to avoid `reflect-metadata` | DI is locked by CLAUDE.md → "Tech stack (locked)"; hand-wiring would diverge from care-service. |
