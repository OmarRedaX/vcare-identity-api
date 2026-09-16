---
title: foundation — Spec
owner: identity-team
service: identity-service
module: foundation
status: ready
version: 1.0.0
diataxis: reference
last_verified: 2026-09-15
tags: [spec, foundation, bootstrap, infrastructure, health, idempotency, rate-limit, logging, testing, ci, docker]
related: [foundation-brainstorm, infrastructure, deployment, overview, quickstart, design-baseline, adr-0007-transactional-outbox-worker, adr-0008-redis-tier-2-fallback-limiter, adr-0013-log-derived-metrics, adr-0014-health-liveness-readiness-split]
contracts: [contracts/openapi.yaml]
---

# foundation — Spec

Scope source: [brainstorm.md](./brainstorm.md). Binding rules: `CLAUDE.md` (cited by section name). This spec is
precise enough to build without guessing; anything it does not name is **out of scope** for this module.

---

## 1. Overview

### 1.1 What the module owns
The runnable skeleton every later module needs, and nothing more:

- tooling (`package.json`, `tsconfig`, ESLint, Jest), Docker, CI;
- entrypoints: `src/server.ts` (two listeners + graceful shutdown), `src/app.ts`, `src/internal-app.ts`,
  `src/routes.ts`, `src/internal-routes.ts`, `src/bootstrap.ts` (DI registration), `src/worker.ts` (empty loop),
  `src/migrate.ts` (migration runner);
- `src/lib/` cross-cutting pieces: `config`, `di`, `error`, `logger`, `request-id`, `http` (response, pagination,
  CORS, no-store, client IP, route capture), `lifecycle` (shutdown/readiness state, in-flight counter), `validation`,
  `knex`, `redis`, `idempotency`, `rate-limit`, `worker` (loop runner), `types`;
- `src/pkg/utils/time.ts`;
- the `health` module (`GET /api/health/live|ready`, `GET /internal/health/live|ready`, ADR 0014);
- the first migration (`citext` extension);
- the test environment (setup, helpers, unit + integration suites).

### 1.2 Principles
1. **Only what day one needs** — no `lib/auth`, `lib/rbac`, `lib/email`, `lib/outbox`, `pkg/utils/crypto.ts`,
   argon2, `jose`, business tables, or the JWKS route (brainstorm → Out of scope).
2. **Byte-compatible with care-service's foundation** for the error/success envelope, `X-Request-Id` handling,
   health response bodies, redaction mechanics, idempotency key `idem:<route>:<principal>:<key>`, and rate-limit
   key `rl:<name>:<subject>` (§12 lists the items to cross-check with Care's spec).
3. **Redis is Tier 2** (ADR 0008): nothing in the foundation fails a request or readiness because Redis is down.
4. **Postgres is the only readiness dependency** (ADR 0014).
5. **No new runtime dependency beyond the locked stack except `reflect-metadata`** (ADR 0015, written by the
   developer as task 0 — §11.2).

### 1.3 Dependencies
- Other modules: none (every later module depends on this one).
- Other services: none. Identity makes no outbound calls; the foundation adds none.
- Infrastructure: PostgreSQL 17 (with `citext` available), Redis 7.

---

## 2. Database schema

No tables. One migration:

| File | `up` | `down` |
|---|---|---|
| `src/migrations/20260915000000_create_citext_extension.ts` | `CREATE EXTENSION IF NOT EXISTS citext;` | `DROP EXTENSION IF EXISTS citext;` |

- Raw SQL via `knex.raw` only (CLAUDE.md → Database rules; `write-migration` skill). File header comment: "citext
  extension — required by `users.email CITEXT` (CLAUDE.md → Database rules)".
- Knex bookkeeping tables `knex_migrations` / `knex_migrations_lock` are created by Knex; nothing else.
- Every pooled connection runs `SET TIME ZONE 'UTC'` (§4.10).

---

## 3. API contract

The four health operations are the only routes. They are infrastructure probes and the **only** routes without
`authorize(...)` (documented exception, brainstorm → Primary flows). They are not rate-limited, not idempotent, need
no token, are not enveloped, and the edge never routes them (hub ADR 0005).

> **Contract status:** the change in §3.3 has been applied to `contracts/openapi.yaml` (2026-09-15). Hub sync is
> still pending.

### 3.1 Liveness — `GET /api/health/live` (public listener), `GET /internal/health/live` (internal listener)

| Item | Value |
|---|---|
| Guard | none |
| Roles | `public` (`x-roles: [public]`) — infrastructure probe, no principal |
| Ownership | none (`x-ownership: none`; internal op also `x-scope: none`) |
| Request | no body, no query; optional `X-Request-Id` |
| Checks | none — the handler answering proves the event loop is responsive |
| `200` | `{ "status": "ok" }` — also during shutdown (liveness never 503) |
| Headers | `X-Request-Id`, `Cache-Control: no-store` |
| Errors | none declared (`x-error-codes: []`); an unexpected throw still yields `500 InternalError` via the handler |
| Idempotency / pagination | n/a |

### 3.2 Readiness — `GET /api/health/ready` (public), `GET /internal/health/ready` (internal)

| Item | Value |
|---|---|
| Guard | none |
| Roles | `public` — infrastructure probe |
| Ownership | none (`x-scope: none` on the internal op) |
| Request | no body, no query; optional `X-Request-Id` |
| Checks (concurrent) | Postgres `SELECT 1`, 500 ms timeout — **fatal**; Redis `PING`, 500 ms timeout — **reported only** (immediately `down` if the client status is not `ready`) |
| Headers | `X-Request-Id`, `Cache-Control: no-store` |
| Errors | none declared |

Decision table (evaluated in `HealthService.readiness()`):

| Shutting down | database | redis | HTTP | body `status` |
|---|---|---|---|---|
| no | up | up | 200 | `ok` |
| no | up | down | 200 | `degraded` |
| no | down | any | 503 | `down` |
| yes | any | any | 503 | `down` |

Body always: `{ "status": "ok" | "degraded" | "down", "checks": { "database": "up" | "down", "redis": "up" | "down" } }`
(`down` exactly when the response is 503; identical in care-service). Checks still run during shutdown (the pool is
destroyed only after both listeners have closed); the shutdown flag comes from `lib/lifecycle` (§4.18). A 503 logs
`readiness_failed` at `warn` with `{ checks, shuttingDown }`.

### 3.3 Contract change (applied 2026-09-15 — do not edit in `/develop`)

1. **Remove** `paths./api/health` (`getPublicHealth`) and `paths./internal/health` (`getInternalHealth`).
2. **Add** these four operations (public ones next to `/.well-known/jwks.json`; internal ones in the internal
   section, each with `servers: [{ url: http://localhost:3100, description: Internal listener (network-isolated) }]`):

```yaml
  /api/health/live:
    get:
      operationId: getPublicLiveness
      tags: [health]
      summary: Public listener liveness (process only)
      description: No dependency checks; never 503 while the process can answer. Bare object (not enveloped). Not routed by the edge (ADR 0014).
      security: []
      x-roles: [public]
      x-ownership: none
      x-error-codes: []
      parameters:
        - $ref: '#/components/parameters/RequestIdHeader'
      responses:
        '200':
          description: Process is alive.
          headers:
            X-Request-Id: { $ref: '#/components/headers/XRequestId' }
            Cache-Control: { $ref: '#/components/headers/CacheControlNoStore' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/HealthLive' }
  /api/health/ready:
    get:
      operationId: getPublicReadiness
      tags: [health]
      summary: Public listener readiness (Postgres fatal, Redis reported)
      description: |
        Postgres `SELECT 1` (500 ms) is fatal; Redis `PING` (500 ms) is reported only (Redis is Tier 2, ADR 0008).
        503 when Postgres is down or shutdown is in progress. Bare object (not enveloped). Not routed by the edge.
      security: []
      x-roles: [public]
      x-ownership: none
      x-error-codes: []
      parameters:
        - $ref: '#/components/parameters/RequestIdHeader'
      responses:
        '200':
          description: Ready. `status` is `degraded` when Redis is down.
          headers:
            X-Request-Id: { $ref: '#/components/headers/XRequestId' }
            Cache-Control: { $ref: '#/components/headers/CacheControlNoStore' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/HealthStatus' }
              examples:
                ok: { value: { status: ok, checks: { database: up, redis: up } } }
                redisDown: { value: { status: degraded, checks: { database: up, redis: down } } }
        '503':
          description: Postgres unreachable, or shutdown in progress.
          headers:
            X-Request-Id: { $ref: '#/components/headers/XRequestId' }
            Cache-Control: { $ref: '#/components/headers/CacheControlNoStore' }
          content:
            application/json:
              schema: { $ref: '#/components/schemas/HealthStatus' }
              example: { status: down, checks: { database: down, redis: up } }
  /internal/health/live:        # operationId getInternalLiveness; same shape as /api/health/live, plus x-scope: none
  /internal/health/ready:       # operationId getInternalReadiness; same shape as /api/health/ready, plus x-scope: none
```

   The two internal operations are written out in full with the same fields as their public twins plus
   `x-scope: none`, descriptions saying "reachable only on the private network".
3. **Schemas:** `HealthStatus` stays the readiness body with `status` enum `[ok, degraded, down]` (`down` ⇔ 503);
   add:
   ```yaml
    HealthLive:
      type: object
      required: [status]
      properties:
        status: { type: string, const: ok }
   ```
4. **Descriptions:** `info.description` "except `/internal/auth/token` and `/internal/health`" →
   "except `/internal/auth/token` and `/internal/health/*`"; tag `health` description → "Liveness and readiness
   probes for both listeners (ADR 0014)."
5. After merge: hub sync (`../vcare-hub/scripts/sync-from-spoke.sh`). `/internal/health` is not called by Care, so
   the internal change is not breaking for Care.

### 3.4 Routes in code

| Router file | Mounted at | Route | Handler |
|---|---|---|---|
| `src/app/health/routes.ts` → `buildHealthRouter()` | `/api/health` (via `src/routes.ts`) and `/internal/health` (via `src/internal-routes.ts`) | `GET /live`, `GET /ready` | `HealthController.live`, `HealthController.ready` |

Unknown paths on either listener → `404 NotFound` envelope. `/internal/*` is never reachable on the public
listener and `/api/*` never on the internal listener.

---

## 4. File list, responsibilities, exported API

All inline `interface`/`type` declarations live in the folder's `types.ts` (CLAUDE.md → Module file conventions,
item 11; enforced by ESLint §6). Signatures are TypeScript; "throws X" means an `AppError` from `lib/error/errors.ts`.

### 4.1 Root files

| File | Responsibility |
|---|---|
| `package.json` | §5 |
| `package-lock.json` | committed |
| `tsconfig.json` | typecheck config (src + tests), `noEmit` |
| `tsconfig.build.json` | build config (src only → `dist/`) |
| `eslint.config.mjs` | §6 |
| `jest.config.js`, `jest.integration.config.js` | §9.1 |
| `Dockerfile`, `.dockerignore`, `docker-compose.yml`, `docker-compose.test.yml` | §7 |
| `docker/postgres/init/01-create-test-database.sql` | `CREATE DATABASE vcare_identity_test OWNER identity;` (dev compose init) |
| `.env.example` | every foundation variable with synthetic values (§4.2), comments naming secrets |
| `.env.test` | test values: `NODE_ENV=test`, `DATABASE_URL=postgres://identity:identity@localhost:5432/vcare_identity_test`, `REDIS_URL=redis://localhost:6379/1`, `LOG_LEVEL=warn`, `SHUTDOWN_TIMEOUT_MS=3000`; committed (synthetic, local only) |
| `.github/workflows/ci.yml` | §8 |
| `.gitignore` | `node_modules`, `dist`, `coverage`, `.env` (not `.env.example`/`.env.test`) |

**`tsconfig.json`** compilerOptions: `target: "ES2023"`, `lib: ["ES2023"]`, `module: "nodenext"`,
`moduleResolution: "nodenext"`, `strict: true`, `noUncheckedIndexedAccess: true`, `noImplicitOverride: true`,
`noFallthroughCasesInSwitch: true`, `experimentalDecorators: true`, `emitDecoratorMetadata: true`,
`esModuleInterop: true`, `forceConsistentCasingInFileNames: true`, `skipLibCheck: true`, `sourceMap: true`,
`types: ["node", "jest"]`, `noEmit: true`; `include: ["src", "tests"]`.
**`tsconfig.build.json`** extends it: `noEmit: false`, `rootDir: "src"`, `outDir: "dist"`, `types: ["node"]`,
`include: ["src"]`. `package.json` has `"type": "commonjs"`, so `nodenext` emits CommonJS and extensionless relative
imports are valid.

**Decorator rule:** `tsx` (esbuild) does not emit decorator metadata, so **every** constructor parameter of an
`@injectable()` class uses an explicit `@inject(TOKENS.X)`. No class relies on type-based auto-injection.

### 4.2 `src/lib/config/`

| File | Exports |
|---|---|
| `env.schema.ts` | `envSchema` (zod object below) |
| `types.ts` | `export type Env = z.infer<typeof envSchema>;` |
| `load-env.ts` | `class EnvValidationError extends Error { readonly invalidKeys: readonly string[] }`; `function loadEnv(source: NodeJS.ProcessEnv): Env` — throws `EnvValidationError` |
| `env.ts` | `export const env: Env` — calls `loadEnv(process.env)`; on `EnvValidationError` writes **one** JSON line to stdout `{"level":"error","message":"invalid_environment","timestamp":…,"service":"identity-service","invalidKeys":[…]}` (never values) and `process.exit(1)` |

Preprocessing: every empty string is treated as `undefined` (so a blank line uses the default, and a blank secret
is "missing"). Unknown variables are ignored.

| Variable | zod | Default | Secret |
|---|---|---|---|
| `NODE_ENV` | `z.enum(["development","test","production"])` | `development` | no |
| `PORT` | `z.coerce.number().int().min(1).max(65535)` | `3000` | no |
| `INTERNAL_PORT` | same | `3100` | no |
| `INTERNAL_HOST` | `z.union([z.ipv4(), z.ipv6()])` | `127.0.0.1` | no |
| `TRUST_PROXY_HOPS` | `z.coerce.number().int().min(0).max(10)` | `0` | no |
| `DATABASE_URL` | `z.url({ protocol: /^postgres(ql)?$/ })` | — | yes |
| `DATABASE_POOL_MAX` | `z.coerce.number().int().min(1).max(100)` | `10` | no |
| `REDIS_URL` | `z.url({ protocol: /^rediss?$/ })` | — | yes |
| `CORS_ORIGINS` | optional string → split on `,`, trim, drop empties → `string[]`; each entry must equal `new URL(entry).origin` with protocol `http:` or `https:` | `[]` | no |
| `LOG_LEVEL` | `z.enum(["debug","info","warn","error"])` | `info` | no |
| `SHUTDOWN_TIMEOUT_MS` | `z.coerce.number().int().min(1000).max(60000)` | `10000` | no |
| `RATE_LIMIT_FALLBACK_DIVISOR` | `z.coerce.number().int().min(1)` | `2` | no |
| `WORKER_POLL_INTERVAL_MS` | `z.coerce.number().int().min(100).max(60000)` | `1000` | no |

Cross-field refinements (issue path = the named key): `INTERNAL_PORT !== PORT` (path `INTERNAL_PORT`);
`LOG_LEVEL === "debug"` with `NODE_ENV === "production"` rejected (path `LOG_LEVEL`).
`TRUST_PROXY_HOPS` is **new** (infrastructure.md §7 names "trust proxy = ingress hop count" without a variable) —
add it to infrastructure.md §1. Every other variable of infrastructure.md §1 is added by the module that first uses it.

### 4.3 `src/lib/di/`

| File | Exports |
|---|---|
| `tokens.ts` | `export const TOKENS = { Env: Symbol.for("Env"), Logger: Symbol.for("Logger"), Db: Symbol.for("Db"), Redis: Symbol.for("Redis"), Lifecycle: Symbol.for("Lifecycle"), HealthService: Symbol.for("HealthService"), HealthController: Symbol.for("HealthController") } as const;` |
| `container.ts` | re-exports tsyringe's `container` only — **no registrations here**, so `lib/` never imports `app/` |

Registration lives in **`src/bootstrap.ts`**: `export function registerDependencies(overrides?: DependencyOverrides): DependencyContainer`
— registers `env`, `logger`, `db`, `redis`, `lifecycle` as values (overrides replace any of `db`, `redis`, `logger`,
`lifecycle` — used by tests), `HealthService` and `HealthController` as singletons; idempotent (a second call without
overrides returns the same container; with overrides it uses `container.createChildContainer()`).
`DependencyOverrides { db?: Knex; redis?: Redis; logger?: Logger; lifecycle?: Lifecycle }` is in `src/types.ts`.

`import "reflect-metadata";` is the first line of `server.ts`, `worker.ts`, `migrate.ts`, and `tests/setup.ts`.

### 4.4 `src/lib/error/`

| File | Exports |
|---|---|
| `types.ts` | `ErrorCode` = string-literal union of the contract's `ErrorCode` enum (all 19 values); `ErrorDetail { field: string; issue: string }`; `ErrorBody { success: false; error: { code: ErrorCode; message: string; details: ErrorDetail[]; requestId: string } }` |
| `AppError.ts` | `class AppError extends Error { readonly code: ErrorCode; readonly status: number; readonly details: readonly ErrorDetail[]; constructor(code: ErrorCode, status: number, message: string, details?: readonly ErrorDetail[] /* default [] */); withDetails(details: readonly ErrorDetail[]): AppError }` — `withDetails` returns a **new** instance (shared instances are never mutated); `name = "AppError"` |
| `errors.ts` | shared instances (messages match the contract examples): `ValidationFailed` (400, "Request validation failed"), `Unauthorized` (401, "Authentication required"), `Forbidden` (403, "You are not allowed to perform this action"), `NotFound` (404, "Resource not found"), `Conflict` (409, "Request conflicts with the current state"), `IdempotencyConflict` (422, "Idempotency-Key was used with a different request body"), `RateLimited` (429, "Too many requests"), `InternalError` (500, "Internal server error"); plus `IdempotencyInProgress = new AppError("Conflict", 409, "A request with this Idempotency-Key is still in progress")` |
| `errorHandler.ts` | `function errorHandler(err: unknown, req: Request, res: Response, next: NextFunction): void`; `function notFoundHandler(req: Request, res: Response, next: NextFunction): void` (calls `next(NotFound)`) |

**`errorHandler` mapping** (first match wins):

| # | Input | Response | Log |
|---|---|---|---|
| 1 | `res.headersSent` | `next(err)` (Express closes the socket) | `error` `response_error_after_headers` with serialized err |
| 2 | `err instanceof AppError` | `err.status`, `{ code, message, details, requestId }` | only if `status >= 500`: `error` `unhandled_error` |
| 3 | body-parser error, `type === "entity.parse.failed"` | 400 `ValidationFailed`, details `[{ field: "body", issue: "must be valid JSON" }]` | none |
| 4 | body-parser `type === "entity.too.large"` | 400 `ValidationFailed`, details `[{ field: "body", issue: "must not exceed 100kb" }]` | none |
| 5 | body-parser `type ∈ {"encoding.unsupported","charset.unsupported"}` | 400 `ValidationFailed`, details `[{ field: "body", issue: "has an unsupported encoding" }]` | none |
| 6 | body-parser `type === "request.aborted"` | no body written (`res.end()` if the socket is still writable) | `info` `request_aborted` |
| 7 | any other error with numeric `status`/`statusCode` in 400..499 | 400 `ValidationFailed`, details `[{ field: "body", issue: "is invalid" }]` | none |
| 8 | anything else | 500 `InternalError` | `error` `unhandled_error` with `{ err }` (name, message, stack) |

Rules: body key order `success`, `error.code`, `error.message`, `error.details`, `error.requestId`; `details` is
**always present**, `[]` when there are none (identical in care-service); `requestId` is `req.requestId`; the body never contains a stack, SQL,
driver message, or `err.message` of a non-`AppError`; the handler never logs `req.body`, `req.headers`, query
string, or cookies; before writing it sets `res.locals.routePattern` if not already set (§4.7 `captureRoute`).

### 4.5 `src/lib/request-id/`

| File | Exports |
|---|---|
| `types.ts` | `RequestContext { requestId: string; userId?: number; clientId?: string }` |
| `context.ts` | `requestContext: AsyncLocalStorage<RequestContext>`; `getRequestContext(): RequestContext \| undefined` |
| `request-id.ts` | `REQUEST_ID_HEADER = "X-Request-Id"`; `UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`; `function requestId(): RequestHandler` |

Behaviour: read `x-request-id`; if it is a single string matching `UUID_PATTERN` adopt it **lower-cased**, else
`crypto.randomUUID()`. Set `req.requestId`, `res.setHeader("X-Request-Id", id)` **before** calling `next`, then
`requestContext.run({ requestId: id }, next)`. It is the first middleware on both apps, so every response
(404, 400 JSON syntax, 429, 500, health) carries the header. Guards added later set `userId`/`clientId` on the
context object.

### 4.6 `src/lib/logger/`

| File | Exports |
|---|---|
| `types.ts` | `LogLevel = "debug" \| "info" \| "warn" \| "error"`; `LogFields = Record<string, unknown>`; `LoggerOptions { service: string; level: LogLevel; production: boolean; sink?: (line: string) => void }`; `MetricUnit = "Count" \| "Milliseconds" \| "Seconds"` |
| `redact.ts` | `REDACTED_KEYS: readonly string[]`; `REDACTED = "[REDACTED]"`; `function redact(value: unknown): unknown` |
| `logger.ts` | `class Logger { constructor(options: LoggerOptions); debug(message: string, fields?: LogFields): void; info(…); warn(…); error(…); metric(name: string, value: number, unit: MetricUnit, dimensions?: Record<string, string>): void; setLevel(level: LogLevel): void }`; `export const logger: Logger` (service `identity-service`, level `env.LOG_LEVEL`, `production = env.NODE_ENV === "production"`, sink `process.stdout.write(line + "\n")`) |
| `request-logger.ts` | `function requestLogger(log?: Logger): RequestHandler` |

**Line format.** One `JSON.stringify` line per call:
`{ level, message, timestamp (new Date().toISOString()), service, requestId?, userId?, clientId?, ...redact(fields) }`.
`requestId`/`userId`/`clientId` come from `getRequestContext()`. Keys `level`, `message`, `timestamp`, `service` in
`fields` are dropped (cannot be overridden). Levels below the threshold are dropped; `debug` is always dropped
when `production` is true. No emojis. The logger never throws (a serialization failure writes
`{ level:"error", message:"log_serialization_failed" }`).

**Redaction mechanics (identical to care-service; the key list differs per service).**
- Walks objects and arrays recursively; a property whose **normalized** key is in the normalized list has its
  value replaced by `"[REDACTED]"` regardless of type.
- Normalization: `key.toLowerCase().replace(/[-_]/g, "")` — so `access_token`, `accessToken`, `Access-Token` match.
- `Error` instances become `{ name, message, stack }` (plus `code` when it is an `AppError`); `stack` only on
  `level === "error"`.
- Depth > 8 → `"[Truncated]"`; circular reference → `"[Circular]"`; `bigint` → string; functions and symbols dropped.
- Never mutates the input.

**`REDACTED_KEYS` (Identity)** — infrastructure.md §2 list plus stored-secret and key-material names:
`password`, `newPassword`, `currentPassword`, `passwordHash`, `token`, `accessToken`, `refreshToken`,
`access_token`, `refresh_token`, `client_secret`, `clientSecret`, `clientSecretHash`, `tokenHash`, `codeHash`,
`privateJwk`, `authorization`, `cookie`, `set-cookie`, `email`, `phone`, `fullName`.
(The additions — `refresh_token`, `clientSecretHash`, `tokenHash`, `codeHash`, `privateJwk` — go into
infrastructure.md §2.)

**`metric()`** (ADR 0013) writes one line: `{ level:"info", message:"metric", timestamp, service, requestId?,
_aws: { Timestamp: <epoch ms>, CloudWatchMetrics: [{ Namespace: "vcare/identity-service", Dimensions: [[…dimension keys]], Metrics: [{ Name: name, Unit: unit }] }] }, [name]: value, ...dimensions }`.
Dimensions go through `redact` too. It is never suppressed by `LOG_LEVEL`.

**`requestLogger`** registers `res.on("finish")` and `res.on("close")` (whichever first, once) and logs
`request_completed` with `{ method, route: res.locals.routePattern ?? "unmatched", status: res.statusCode, durationMs }`
(`durationMs` from `process.hrtime.bigint()`, rounded to 0.1 ms; `status` is `499` when `close` fires before
`finish`). Level: `error` when status ≥ 500, else `info`. Requests whose pattern starts with `/api/health/` or
`/internal/health/` are **not** logged when status < 500. It never logs headers, query strings, raw URLs, or bodies.

### 4.7 `src/lib/http/`

| File | Exports |
|---|---|
| `types.ts` | `SuccessBody<T> { success: true; data: T; meta?: Record<string, unknown> }`; `CorsOptions { origins: readonly string[] }` |
| `response.ts` | `sendSuccess<T>(res: Response, data: T, status?: 200 \| 201 \| 202, meta?: Record<string, unknown>): void` (default 200; `meta` key omitted when `undefined`); `sendNoContent(res: Response): void` (204, no body); `sendRaw(res: Response, status: number, body: object): void` (bare JSON for health/JWKS) |
| `no-store.ts` | `noStore(): RequestHandler` — sets `Cache-Control: no-store` |
| `cors.ts` | `cors(options: CorsOptions): RequestHandler` |
| `client-ip.ts` | `clientIp(req: Request): string` — `req.ip ?? req.socket.remoteAddress ?? "unknown"`, IPv4-mapped IPv6 (`::ffff:a.b.c.d`) normalized to `a.b.c.d`; trustworthy behind proxies because both apps set `trust proxy` = `TRUST_PROXY_HOPS` |
| `route-capture.ts` | `captureRoute(req: Request, res: Response): void` — if `req.route` is set and `res.locals.routePattern` is not, sets it to `req.baseUrl + req.route.path`; `routeCaptureOnError(): ErrorRequestHandler` — calls `captureRoute` then `next(err)`; `sealRouter(router: Router): Router` — appends `routeCaptureOnError()` and returns the router |
| `pagination/types.ts` | `CursorPayload { v: string \| number; id: number }`; `PaginationMeta { nextCursor: string \| null; hasMore: boolean; count: number }`; `Page<T> { items: T[]; meta: PaginationMeta }` |
| `pagination/cursor.ts` | `encodeCursor(payload: CursorPayload): string` (base64url of JSON); `decodeCursor(cursor: string): CursorPayload` — throws `ValidationFailed.withDetails([{ field: "cursor", issue: "is invalid" }])` on bad base64url, bad JSON, wrong shape (`v` not string/finite number, `id` not a positive safe integer), or length > 512 |
| `pagination/page.ts` | `buildPage<T>(rows: T[], limit: number, cursorOf: (row: T) => CursorPayload): Page<T>` — `hasMore = rows.length > limit`; `items = rows.slice(0, limit)`; `nextCursor = hasMore ? encodeCursor(cursorOf(last item)) : null`; `count = items.length` |
| `pagination/pagination-query.dto.ts` | `class PaginationQueryDto { cursor?: string /* @IsOptional @IsString @MaxLength(512) */; limit: number = 20 /* @IsOptional @Type(() => Number) @IsInt @Min(1) @Max(100) */ }` — modules extend it with whitelisted filters |

`sendSuccess`, `sendNoContent`, `sendRaw` call `captureRoute(res.req, res)` before writing, so the request log has
the pattern. Every module router (including health) is returned through `sealRouter(...)` so errors thrown in a
handler still record the pattern before leaving the router.

**CORS (in-house, public listener only, never in production).** Mounted by `createApp` only when
`env.NODE_ENV !== "production"` and `env.CORS_ORIGINS.length > 0`; in production a non-empty `CORS_ORIGINS` logs
`cors_origins_ignored_in_production` at `warn` at boot. The internal app never mounts it.

| Request | Behaviour |
|---|---|
| no `Origin` header | `next()` untouched |
| `Origin` not in allowlist (exact string match) | `next()`, no CORS headers |
| allowed, non-`OPTIONS` | set `Access-Control-Allow-Origin: <origin>`, `Access-Control-Allow-Credentials: true`, `Access-Control-Expose-Headers: X-Request-Id, Retry-After`, append `Vary: Origin`; `next()` |
| allowed, `OPTIONS` with `Access-Control-Request-Method` | the headers above plus `Access-Control-Allow-Methods: GET, POST, PATCH, DELETE, OPTIONS`, `Access-Control-Allow-Headers: Authorization, Content-Type, Idempotency-Key, X-Request-Id`, `Access-Control-Max-Age: 600`; respond `204` |

### 4.8 `src/lib/validation/`

| File | Exports |
|---|---|
| `types.ts` | `ClassType<T> = new () => T` |
| `validate.ts` | `validateBody<T extends object>(dto: ClassType<T>, body: unknown): Promise<T>`; `validateQuery<T extends object>(dto: ClassType<T>, query: unknown): Promise<T>`; `validateParams<T extends object>(dto: ClassType<T>, params: unknown): Promise<T>` |

| Step | Body | Query / Params |
|---|---|---|
| Input shape | must be a plain object (not `null`, array, primitive, `undefined`) else throw `ValidationFailed.withDetails([{ field: "body", issue: "must be a JSON object" }])` | `undefined` treated as `{}` |
| `plainToInstance` options | `{ enableImplicitConversion: false, exposeDefaultValues: true }` | `{ enableImplicitConversion: true, exposeDefaultValues: true }` |
| `validate` options | `{ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, validationError: { target: false, value: false } }` | same |
| Failure | throw `ValidationFailed.withDetails(details)` | same |

`details`: one entry per failing property path, `field` = dotted path (`address.city`, `items.0.name`), `issue` =
the **first** constraint message of that property. A non-whitelisted property yields
`{ field: "<name>", issue: "is not allowed" }`. Validated values are returned; `req.query` is never reassigned
(Express 5 getter).

### 4.9 `src/lib/types/`

| File | Content |
|---|---|
| `types.ts` | `UserAuth { kind: "user"; userId: number; role: string; status: string; ev: boolean }`; `ServiceAuth { kind: "service"; clientId: string; scopes: readonly string[] }`; `RequestAuth = UserAuth \| ServiceAuth` — declared only; guards (later) populate it and narrow `role`/`status` to module enums |
| `express.d.ts` | `declare global { namespace Express { interface Request { requestId: string; auth?: RequestAuth } } }` |

### 4.10 `src/lib/knex/`

| File | Exports |
|---|---|
| `types.ts` | `KnexOptions { databaseUrl: string; poolMax: number; statementTimeoutMs: number \| null }` |
| `knexfile.ts` | `function buildKnexConfig(options: KnexOptions): Knex.Config`; `function migrationConfig(databaseUrl: string): Knex.Config` |
| `knex.ts` | `STATEMENT_TIMEOUT_MS = 2000`; `export const db: Knex = knex(buildKnexConfig({ databaseUrl: env.DATABASE_URL, poolMax: env.DATABASE_POOL_MAX, statementTimeoutMs: STATEMENT_TIMEOUT_MS }))`; `pingDatabase(conn?: Knex): Promise<void>` is **not** here (it lives in the health repository) |

`buildKnexConfig`: `client: "pg"`, `connection: { connectionString, statement_timeout?: statementTimeoutMs }` (omitted
when `null`), `pool: { min: 0, max: poolMax, acquireTimeoutMillis: 1000, afterCreate: (conn, done) => conn.query("SET TIME ZONE 'UTC'", err => done(err, conn)) }`,
`acquireConnectionTimeout: 1000`. `migrationConfig`: same with `statementTimeoutMs: null`, `poolMax: 2`, and
`migrations: { directory: path.join(__dirname, "../../migrations"), tableName: "knex_migrations", loadExtensions: [path.extname(__filename)] }`
(`.ts` under `tsx`, `.js` in `dist`). The worker uses `db` as well (2 s timeout; later jobs are batched).

### 4.11 `src/lib/redis/`

| File | Exports |
|---|---|
| `types.ts` | `RedisHealth = "up" \| "down"` |
| `redis.ts` | `function createRedis(url: string): Redis`; `export const redis: Redis`; `isRedisReady(client?: Redis): boolean` (`client.status === "ready"`); `withTimeout<T>(promise: Promise<T>, ms: number): Promise<T>` (rejects with `Error("redis_timeout")`); `pingRedis(client: Redis, timeoutMs: number): Promise<RedisHealth>` (never throws); `connectRedis(client: Redis, log: Logger): void` (calls `connect()`, logs failure at `warn` `redis_connect_failed`, never throws) |

`createRedis` options: `lazyConnect: true`, `enableOfflineQueue: false` (commands fail fast while disconnected),
`maxRetriesPerRequest: 1`, `connectTimeout: 2000`, `retryStrategy: times => Math.min(times * 200, 2000)` (reconnect
forever). Event logs (no URL, no credentials): `redis_ready` (`info`), `redis_error` (`warn`, error name only, at most
once per 10 s), `redis_reconnecting` (`debug`).

### 4.12 `src/lib/idempotency/`

| File | Exports |
|---|---|
| `types.ts` | `IdempotencyOptions { required: boolean }`; `IdempotencyDeps { redis: Redis; logger: Logger }`; `IdempotencyRecord { v: 1; state: "in_flight" \| "completed"; bodyHash: string; status?: number; body?: unknown }` |
| `idempotency.ts` | `IDEMPOTENCY_TTL_MS = 86_400_000`; `IN_FLIGHT_TTL_MS = 60_000`; `IDEMPOTENCY_REDIS_TIMEOUT_MS = 100`; `function idempotency(options: IdempotencyOptions, deps?: IdempotencyDeps): RequestHandler`; `function idempotencyKey(req: Request, key: string): string`; `function hashBody(body: unknown): string` |

- **Redis key (identical in care-service):** `idem:<route>:<principal>:<key>` where `<route>` =
  `` `${req.method} ${req.baseUrl}${req.path}` `` — the **concrete** path, never the route pattern (with the pattern, one
  key sent to two resource ids would replay the wrong response), never the query string (e.g.
  `POST /api/auth/register/complete`, `PATCH /internal/users/42/status`); `<principal>` = `user:<userId>` |
  `client:<clientId>` (from `req.auth`) | `ip:<clientIp(req)>`; `<key>` = the lower-cased UUID.
  Example: `idem:POST /api/auth/register/complete:ip:203.0.113.7:3f0c9a2e-…`.
- **Body hash:** sha256 hex of a stable JSON serialization (object keys sorted recursively; `undefined` body → `null`).
- Placement: route-level, after guard and authorize (CLAUDE.md → Module file conventions, item 7); it calls
  `captureRoute` on entry.

| # | Situation | Result |
|---|---|---|
| 1 | Header absent, `required: true` | `400 ValidationFailed`, details `[{ field: "Idempotency-Key", issue: "is required" }]` |
| 2 | Header absent, `required: false` | `next()` — no Redis access |
| 3 | Header present, not a UUID (or repeated header) | `400 ValidationFailed`, details `[{ field: "Idempotency-Key", issue: "must be a UUID" }]` |
| 4 | `isRedisReady()` is false | skip: `warn` `idempotency_skipped` `{ reason: "redis_unavailable" }`; `next()` (ADR 0008 — DB constraints stop duplicates) |
| 5 | `SET key <in_flight record> NX PX 60000` succeeds | run handler; capture body by wrapping `res.json` (and `res.send` for non-JSON; `null` for 204) |
| 5a | …handler finishes with status < 500 | `SET key <completed record {status, body}> PX 86400000` (fire-and-forget; failure → `warn` `idempotency_store_failed`, response unaffected) |
| 5b | …handler finishes with status ≥ 500 | `DEL key` so a retry re-executes |
| 5c | …client disconnects before `finish` | `DEL key` |
| 6 | `SET NX` fails; stored `bodyHash` ≠ request hash (any state) | `422 IdempotencyConflict` |
| 7 | `SET NX` fails; same hash, `state: "completed"` | replay: `res.status(stored.status)`; body `null` → `end()`, else `json(stored.body)`; if the stored body is an error envelope, `error.requestId` is replaced with the current request id; the handler does **not** run |
| 8 | `SET NX` fails; same hash, `state: "in_flight"` (concurrent same key) | `409 Conflict` via `IdempotencyInProgress`, header `Retry-After: 1`; the handler does **not** run |
| 9 | `SET NX` fails but `GET` returns nothing (expired in between) | retry step 5 once; if it fails again, behave as row 8 |
| 10 | Any Redis command before the handler errors or exceeds 100 ms | skip as row 4 with `reason: "redis_error"` |
| 11 | Stored value unparsable / wrong `v` | `DEL key`, then continue as row 5 |

Response headers are not stored or replayed (only status and body). No request body or key value is logged.

### 4.13 `src/lib/rate-limit/`

| File | Exports |
|---|---|
| `types.ts` | `DegradeMode = "fallback" \| "fail-open"`; `RateLimitOptions { name: string; limit: number; windowMs: number; subject: (req: Request) => string; degrade: DegradeMode }`; `RateLimitDeps { redis: Redis; logger: Logger; fallbackDivisor: number; now: () => number }`; `RateLimitDecision { allowed: boolean; retryAfterSeconds: number }` |
| `sliding-window.lua.ts` | `SLIDING_WINDOW_SCRIPT: string` |
| `in-process-limiter.ts` | `class InProcessLimiter { constructor(maxKeys?: number /* 10_000 */); hit(key: string, limit: number, windowMs: number, now: number): RateLimitDecision }` |
| `rate-limit.ts` | `RATE_LIMIT_REDIS_TIMEOUT_MS = 50`; `function rateLimit(options: RateLimitOptions, deps?: RateLimitDeps): RequestHandler`; `function fallbackLimit(limit: number, divisor: number): number` (= `Math.max(1, Math.floor(limit / divisor))`) |

- **Redis key:** `rl:<name>:<subject>`. Subjects that contain PII are hashed by the caller (e.g.
  `sha256(lower(email))`, infrastructure.md §7); the factory never logs the subject.
- **Algorithm (sliding-window log, atomic Lua, Redis clock):** `TIME` → `now_ms`; `ZREMRANGEBYSCORE key 0 now_ms-window`;
  `count = ZCARD key`; if `count < limit`: `ZADD key now_ms <now_ms>-<ARGV random member>` and `PEXPIRE key window`,
  return `{1, 0}`; else read the oldest score and return `{0, ceil((oldest + window - now_ms)/1000)}`. Rejected
  attempts are not recorded. The script is registered with `redis.defineCommand("rlSlidingWindow", { numberOfKeys: 1, lua })`.
- `retryAfterSeconds` is at least 1.
- Placement: route-level, **before** body validation (and, later, before hashing). It calls `captureRoute` on entry.

| # | Situation | Result |
|---|---|---|
| 1 | Redis ready, script allows | `next()` |
| 2 | Redis ready, script denies | set `Retry-After: <n>`; `warn` `rate_limited` `{ limiter: name, degraded: false }`; `metric("rate_limited", 1, "Count", { limiter })`; `next(RateLimited)` |
| 3 | Redis not ready, or script errors, or exceeds 50 ms — `degrade: "fallback"` | use the process-wide `InProcessLimiter` with key `rl:<name>:<subject>` and limit `fallbackLimit(limit, RATE_LIMIT_FALLBACK_DIVISOR)`; allow → `next()`, deny → as row 2 with `degraded: true`; emit `warn` `rate_limiter_degraded` `{ limiter, mode: "fallback" }` + `metric("rate_limiter_degraded", 1, "Count", { limiter })` at most once per 60 s per limiter |
| 4 | Same failure — `degrade: "fail-open"` | `next()`; `rate_limiter_degraded` `{ limiter, mode: "fail-open" }` + metric, same throttling |
| 5 | Redis becomes ready again | next request uses Redis (row 1/2); in-process state is kept but unused |

`InProcessLimiter` keeps `Map<string, number[]>` of timestamps, prunes on each hit, and when it holds `maxKeys`
keys evicts the oldest-inserted key before adding a new one.

### 4.14 `src/lib/worker/`

| File | Exports |
|---|---|
| `types.ts` | `LoopOptions { name: string; intervalMs: number; tick: (signal: AbortSignal) => Promise<void>; logger: Logger }`; `LoopHandle { stop(): Promise<void>; readonly stopped: Promise<void> }` |
| `run-loop.ts` | `function runLoop(options: LoopOptions): LoopHandle` |

Behaviour: starts immediately; runs `tick(signal)`, then sleeps `intervalMs` (sleep resolves early on abort), repeats.
Ticks never overlap. A tick that throws logs `error` `worker_tick_failed` `{ loop: name, err }` and the loop continues.
`stop()` aborts the signal, lets the **current** tick finish, never starts another, and resolves `stopped`; calling
it twice returns the same promise.

### 4.15 `src/pkg/utils/time.ts`

`type DurationUnit = "ms" | "s" | "m" | "h" | "d"` lives in `src/pkg/utils/types.ts`.
- `toMs(amount: number, unit: DurationUnit): number` — throws `RangeError` for non-finite or negative amounts.
- `addTime(date: Date, amount: number, unit: DurationUnit): Date` — returns a new `Date`.
Pure: no env, no clock, no imports from `lib/` or `app/`. (`isPast` from CLAUDE.md → Code style lands with the first
module that needs a clock comparison.) The foundation's own constants (24 h idempotency TTL, etc.) are written with
`toMs`.

### 4.16 `src/app/health/`

| File | Exports |
|---|---|
| `enums.ts` | `enum HealthState { Ok = "ok", Degraded = "degraded", Down = "down" }`; `enum DependencyState { Up = "up", Down = "down" }` |
| `types.ts` | `ReadinessResult { httpStatus: 200 \| 503; body: ReadinessBody }`; `ReadinessBody { status: HealthState; checks: { database: DependencyState; redis: DependencyState } }`; `LivenessBody { status: HealthState.Ok }` |
| `repository/health.repo.ts` | `function pingDatabase(conn: Knex = db): Promise<void>` — `conn.raw("SELECT 1")` |
| `service/health.service.ts` | `@injectable() class HealthService { constructor(@inject(TOKENS.Db) db: Knex, @inject(TOKENS.Redis) redis: Redis, @inject(TOKENS.Lifecycle) lifecycle: Lifecycle, @inject(TOKENS.Logger) logger: Logger); liveness(): LivenessBody; readiness(): Promise<ReadinessResult> }` — `CHECK_TIMEOUT_MS = 500`; reads `lifecycle.isShuttingDown()` |
| `dto/health.response.dto.ts` | `class LivenessResponseDto { status; static from(body: LivenessBody) }`; `class ReadinessResponseDto { status; checks; static from(body: ReadinessBody) }` |
| `controller/health.controller.ts` | `@injectable() class HealthController { constructor(@inject(TOKENS.HealthService) service: HealthService); live = (req, res) => void; ready = async (req, res) => Promise<void> }` — both set `Cache-Control: no-store` and use `sendRaw` |
| `routes.ts` | `function buildHealthRouter(): Router` — `GET /live`, `GET /ready`, returned via `sealRouter` |

No `entity`, `request.dto`, `errors.ts`, or `policies.ts` (no domain, no input, no RBAC — documented probe exception;
the route file carries a comment citing brainstorm → Primary flows and ADR 0014).
`readiness()` runs `pingDatabase` (raced with 500 ms) and `pingRedis(redis, 500)` concurrently, then applies §3.2.

### 4.17 Entrypoints

**`src/app.ts`** — `function createApp(options?: AppOptions): Express` (`AppOptions { extraApiRouter?: Router }` in
`src/types.ts`). Order:
1. `app.disable("x-powered-by")`; `app.set("trust proxy", env.TRUST_PROXY_HOPS)`
2. `inflightTracker(lifecycle)` (from `lib/lifecycle`)
3. `requestId()`
4. `requestLogger()`
5. `helmet({ hsts: env.NODE_ENV === "production" })`
6. `cors({ origins: env.CORS_ORIGINS })` — per §4.7 conditions
7. `express.json({ limit: "100kb", strict: true, type: "application/json" })`
8. `app.use("/api", buildPublicRouter())`
9. `if (options?.extraApiRouter) app.use("/api", options.extraApiRouter)` — tests only
10. `notFoundHandler`, then `errorHandler`

**`src/internal-app.ts`** — `function createInternalApp(options?: InternalAppOptions): Express`
(`InternalAppOptions { extraInternalRouter?: Router }`): same order without CORS, with `helmet({ hsts: false })`,
mounting `buildInternalRouter()` at `/internal` (and the optional test router at `/internal`).

**`src/routes.ts`** — `function buildPublicRouter(): Router` → `router.use("/health", buildHealthRouter())`.
**`src/internal-routes.ts`** — `function buildInternalRouter(): Router` → `router.use("/health", buildHealthRouter())`.
Both files carry a comment: "mount module routers here; internal controllers are never imported by routes.ts".

**`src/server.ts`**
- `export async function startServer(): Promise<RunningServer>` (`RunningServer { publicServer: http.Server; internalServer: http.Server; shutdown(reason: ShutdownReason): Promise<number> }`, `ShutdownReason = "SIGTERM" | "SIGINT" | "uncaughtException" | "unhandledRejection"`; types in `src/types.ts`).
- Boot: `registerDependencies()` (from `src/bootstrap.ts`) → `connectRedis(redis, logger)` (not awaited; Redis is Tier 2) → create both apps →
  `publicServer.listen(env.PORT)` (all interfaces) and `internalServer.listen(env.INTERNAL_PORT, env.INTERNAL_HOST)`
  → log `server_listening` `{ listener: "public" | "internal", port, host }` each. A listen error logs
  `error` `server_listen_failed` and exits 1. Postgres is not awaited at boot (readiness reports it).
- Both servers: `keepAliveTimeout = 65_000`, `headersTimeout = 66_000` (longer than a 60 s LB idle timeout).
- `if (require.main === module)`: `startServer()` and install handlers: `SIGTERM`, `SIGINT` →
  `shutdown(signal)` then `process.exit(code)`; `uncaughtException`, `unhandledRejection` → `error`
  `uncaught_exception` / `unhandled_rejection` `{ err }` → `shutdown(...)` → exit with **1**.

**Shutdown sequence** (infrastructure.md §6), run at most once (later calls return the first promise):

| Step | Action |
|---|---|
| 1 | `lifecycle.markShuttingDown()` — readiness returns 503; `info` `shutdown_started` `{ reason }` |
| 2 | `publicServer.close()` and `internalServer.close()` (stop accepting); `closeIdleConnections()` on both |
| 3 | Wait for both `close` callbacks (in-flight requests and their transactions finish), raced against `SHUTDOWN_TIMEOUT_MS` |
| 4 | Nothing to flush (email work is durable in the outbox — ADR 0007) |
| 5 | `await db.destroy()`; `await redis.quit()` (on error `redis.disconnect()`) |
| 6 | Resolve exit code `0` (or `1` when the reason is `uncaughtException`/`unhandledRejection`). If the deadline passes first: `error` `shutdown_timeout` `{ unfinishedRequests: lifecycle.inflightCount() }`, `closeAllConnections()` on both servers, run step 5, resolve `1` |

**`src/bootstrap.ts`** — `registerDependencies(overrides?)` (§4.3): the only file that wires `lib/` singletons and
`app/` classes into the container; imported by `server.ts`, `worker.ts`, and `tests/helpers/app.ts`.

**`src/worker.ts`** — `export async function startWorker(): Promise<WorkerHandle>` (`WorkerHandle { shutdown(reason: ShutdownReason): Promise<number> }`).
Registers dependencies (no Redis connect — the worker does not use Redis yet), starts
`runLoop({ name: "worker", intervalMs: env.WORKER_POLL_INTERVAL_MS, tick: async () => {} , logger })` with a comment
"job handlers are registered here by the outbox module (ADR 0007)", logs `worker_started`. On `SIGTERM`/`SIGINT`:
`worker_stopping` → `loop.stop()` raced against `SHUTDOWN_TIMEOUT_MS` → `db.destroy()`, `redis.disconnect()` → exit 0
(timeout → `error` `worker_shutdown_timeout`, exit 1). Uncaught errors → same with exit 1.

**`src/migrate.ts`** — CLI: `latest` | `rollback` | `rollback --all` | `status` | `make <snake_case_name>`.
Uses `knex(migrationConfig(env.DATABASE_URL))`; logs `migrations_applied` `{ batch, count }` (file names allowed);
exit 0/1; always destroys its pool. `make` writes `src/migrations/<YYYYMMDDHHMMSS>_<name>.ts` with the
`write-migration` template (`knex.raw` in `up` and `down`, header comment) and refuses names not matching
`^[a-z0-9_]+$`.

### 4.18 `src/lib/lifecycle/`

| File | Exports |
|---|---|
| `lifecycle.ts` | `class Lifecycle { markShuttingDown(): void; isShuttingDown(): boolean; requestStarted(): void; requestEnded(): void; inflightCount(): number }`; `export const lifecycle: Lifecycle` (process-wide) |
| `inflight.ts` | `inflightTracker(lc?: Lifecycle): RequestHandler` — `requestStarted()` on entry, `requestEnded()` exactly once on the first of `finish`/`close` |

Shared by `server.ts`, `worker.ts`, and `HealthService`; imports nothing from `app/`. `markShuttingDown` is
idempotent; `inflightCount` never goes below 0.

---

## 5. `package.json`

- `"name": "vcare-identity-api"`, `"private": true`, `"type": "commonjs"`, `"engines": { "node": ">=24 <25" }`.

**Runtime dependencies (locked stack subset used now, latest within the major):**
`express@^5`, `helmet@^8`, `class-validator@^0.14`, `class-transformer@^0.5`, `zod@^4`, `tsyringe@^4`,
`reflect-metadata@^0.2` (ADR 0015), `knex@^3`, `pg@^8`, `ioredis@^5`.
Not yet: `jose`, `argon2`, `bcrypt` (each lands with its module). Forbidden and absent: `cors`, `uuid`, `dotenv`.

**Dev dependencies:** `typescript@^5.9`, `tsx@^4`, `@types/node@^24`, `@types/express@^5`, `jest@^30`,
`ts-jest@^29.4`, `@types/jest@^30`, `supertest@^7`, `@types/supertest@^6`, `eslint@^9`, `@eslint/js@^9`,
`typescript-eslint@^8`.

**Scripts:**

| Script | Command |
|---|---|
| `dev` | `tsx watch --env-file-if-exists=.env src/server.ts` |
| `dev:worker` | `tsx watch --env-file-if-exists=.env src/worker.ts` |
| `build` | `tsc -p tsconfig.build.json` |
| `start` | `node dist/server.js` |
| `start:worker` | `node dist/worker.js` |
| `typecheck` | `tsc -p tsconfig.json` |
| `lint` | `eslint .` |
| `test` | `jest --config jest.config.js` |
| `test:integration` | `jest --config jest.integration.config.js --runInBand` |
| `migrate` | `tsx --env-file-if-exists=.env src/migrate.ts latest` |
| `migrate:rollback` | `tsx --env-file-if-exists=.env src/migrate.ts rollback` |
| `migrate:status` | `tsx --env-file-if-exists=.env src/migrate.ts status` |
| `migrate:make` | `tsx src/migrate.ts make` |

Production migration task: `node dist/migrate.js latest` (deployment.md → `identity-migrate`).

---

## 6. ESLint (`eslint.config.mjs`, flat config)

Base: `@eslint/js` recommended + `typescript-eslint` `recommendedTypeChecked` (parserOptions `projectService: true`).
Ignores: `dist/`, `coverage/`, `node_modules/`.

**All `src/**/*.ts` and `tests/**/*.ts`:**
- `@typescript-eslint/no-explicit-any: "error"`; `no-console: "error"`; `@typescript-eslint/no-floating-promises: "error"`.
- `no-restricted-imports` → `paths`/`patterns` (message: "Forbidden by CLAUDE.md → Tech stack (locked)"):
  `prisma`, `@prisma/*`, `typeorm`, `sequelize`, `sequelize-typescript`, `drizzle-orm`, `drizzle-orm/*`, `kysely`,
  `@mikro-orm/*`, `@nestjs/*`, `graphql`, `@apollo/*`, `apollo-server*`, `@grpc/*`, `grpc`, `@trpc/*`, `passport`,
  `passport-*`, `auth0`, `@auth0/*`, `@clerk/*`, `jsonwebtoken`, `moment`, `moment-timezone`, `cors`, `uuid`,
  `dotenv`, `axios`, `node-fetch`.

**`src/**/*.ts` except `**/types.ts` and `**/*.d.ts`:**
- `no-restricted-syntax`: `TSInterfaceDeclaration` and `TSTypeAliasDeclaration` → "Declare types in the folder's types.ts
  (CLAUDE.md → Module file conventions)".

**Layering overrides (merged with the list above):**

| Files | Additional restricted patterns |
|---|---|
| `src/pkg/**` | `**/lib/**`, `**/app/**`, `express`, `knex`, `pg`, `ioredis`, `tsyringe`, `zod` — "pkg/ is pure (CLAUDE.md → Folder structure and layering)" |
| `src/lib/**` | `**/app/**` — "lib/ must not import app/" |
| `src/app/**` | `../../*/repository/*`, `**/app/*/repository/*` from outside the module — "cross-module calls go through services" (a module's own `../repository/*` stays allowed) |
| `src/app.ts`, `src/routes.ts` | `./internal-routes`, `./internal-app`, `**/internal-*/**` — "public app never imports internal routers or controllers" |

`no-console` is off only in `eslint.config.mjs` itself (none needed elsewhere; `env.ts` writes via `process.stdout.write`).

---

## 7. Docker

**`Dockerfile`** (one image for `identity-api`, `identity-worker`, `identity-migrate`):

| Stage | From | Steps |
|---|---|---|
| `deps` | `node:24-alpine` | `WORKDIR /app`; copy `package.json package-lock.json`; `npm ci` |
| `build` | `deps` | copy `tsconfig.json tsconfig.build.json src/`; `npm run build` |
| `prod-deps` | `node:24-alpine` | copy lock files; `npm ci --omit=dev`. Comment: "argon2 (auth module) needs `apk add --no-cache python3 make g++` here; this stage exists so native builds never reach the runtime image" |
| `runtime` | `node:24-alpine` | `ENV NODE_ENV=production`; `WORKDIR /app`; `COPY --chown=node:node` `prod-deps:/app/node_modules`, `build:/app/dist`, `package.json`; `USER node`; `EXPOSE 3000 3100`; `CMD ["node", "dist/server.js"]` |

No `HEALTHCHECK` (the orchestrator probes HTTP). No `.env` in the image.

**`.dockerignore`:** `node_modules`, `dist`, `coverage`, `.git`, `.github`, `.claude`, `docs`, `tests`, `.env`,
`.env.*`, `docker-compose*.yml`, `*.md`.

**`docker-compose.yml`** (local dev; synthetic credentials):

| Service | Definition |
|---|---|
| `postgres` | `postgres:17-alpine`; env `POSTGRES_USER=identity`, `POSTGRES_PASSWORD=identity`, `POSTGRES_DB=vcare_identity`; ports `5432:5432`; volume `identity-pg:/var/lib/postgresql/data`; `./docker/postgres/init:/docker-entrypoint-initdb.d:ro`; healthcheck `pg_isready -U identity -d vcare_identity` (5 s interval, 10 retries) |
| `redis` | `redis:7-alpine`; ports `6379:6379`; healthcheck `redis-cli ping` |
| `migrate` | `build: .`; `command: ["node", "dist/migrate.js", "latest"]`; env `DATABASE_URL=postgres://identity:identity@postgres:5432/vcare_identity`, `REDIS_URL=redis://redis:6379`; `depends_on: postgres: service_healthy`; `restart: "no"` |
| `api` | `build: .`; `init: true`; ports `3000:3000`, `3100:3100`; env as `migrate` plus `NODE_ENV=development`, `INTERNAL_HOST=0.0.0.0` (container bind so the host port mapping works; production binds the private interface), `CORS_ORIGINS=http://localhost:5173`, `LOG_LEVEL=info`; `depends_on: migrate: service_completed_successfully, redis: service_healthy` |
| `worker` | `build: .`; `init: true`; `command: ["node", "dist/worker.js"]`; env as `migrate`; `depends_on: migrate: service_completed_successfully` |

Volumes: `identity-pg`. Care runs its stack on host ports 5433/6380/3001/3101, so both stacks run side by side.

**`docker-compose.test.yml`** (hermetic run, no host ports): `postgres` (`postgres:17-alpine`, db
`vcare_identity_test`, healthcheck), `redis` (`redis:7-alpine`, healthcheck), and `test` (`node:24-alpine`,
`working_dir: /app`, volumes `.:/app` and anonymous `/app/node_modules`, env `NODE_ENV=test`,
`DATABASE_URL=postgres://identity:identity@postgres:5432/vcare_identity_test`, `REDIS_URL=redis://redis:6379/1`,
`LOG_LEVEL=warn`, depends on both healthy, `command: sh -e -c "npm ci && npm run lint && npm run typecheck && npm test && npm run test:integration"`).
Usage: `docker compose -f docker-compose.test.yml run --rm test; docker compose -f docker-compose.test.yml down -v`.

---

## 8. CI — `.github/workflows/ci.yml`

- Triggers: `push` to `main`, `pull_request`, `workflow_dispatch`. `concurrency: { group: ci-${{ github.ref }}, cancel-in-progress: true }`. `permissions: contents: read`.

| Job | Steps |
|---|---|
| `verify` (ubuntu-latest) | `actions/checkout@v4`; `actions/setup-node@v4` (`node-version: 24`, `cache: npm`); `npm ci`; `npm run lint`; `npm run typecheck`; `npm test`; `npm run migrate` → `npx tsx src/migrate.ts rollback --all` → `npm run migrate` (proves every `down`); `npm run test:integration` |
| `verify` services | `postgres: postgres:17-alpine` (env user/password `identity`, db `vcare_identity_test`; ports `5432:5432`; options `--health-cmd "pg_isready -U identity" --health-interval 5s --health-retries 10`); `redis: redis:7-alpine` (ports `6379:6379`; `--health-cmd "redis-cli ping"`) |
| `verify` env | `NODE_ENV=test`, `DATABASE_URL=postgres://identity:identity@localhost:5432/vcare_identity_test`, `REDIS_URL=redis://localhost:6379/1`, `LOG_LEVEL=warn` |
| `docker` (needs `verify`) | checkout; `docker build --tag vcare-identity-api:${{ github.sha }} .` (no push — the release pipeline is platform-owned, hub `deployment.md`) |

---

## 9. Test plan

### 9.1 Configuration and helpers

| File | Content |
|---|---|
| `jest.config.js` | `preset: "ts-jest"`, `testEnvironment: "node"`, `roots: ["<rootDir>/tests/unit"]`, `testMatch: ["**/*.test.ts"]`, `setupFiles: ["<rootDir>/tests/setup.ts"]`, `clearMocks: true` |
| `jest.integration.config.js` | same preset; `roots: ["<rootDir>/tests/integration"]`; `setupFiles: ["<rootDir>/tests/setup.ts"]`; `globalSetup: "<rootDir>/tests/integration/global-setup.ts"`; `maxWorkers: 1`; `testTimeout: 20000` |
| `tests/setup.ts` | `import "reflect-metadata"`; `process.loadEnvFile(".env.test")` when the file exists (existing variables win, so CI values apply). **No infra mocks.** |
| `tests/integration/global-setup.ts` | loads `.env.test`, runs `latest` migrations via `migrationConfig`, destroys its pool |
| `tests/helpers/db.ts` | `truncateAll(): Promise<void>` (all `public` tables except `knex_migrations`, `knex_migrations_lock`; `TRUNCATE … RESTART IDENTITY CASCADE`; no-op when none); `closeDb(): Promise<void>` |
| `tests/helpers/redis.ts` | `flushTestKeys(): Promise<void>` (SCAN + DEL of `idem:*` and `rl:*` on the test DB index); `createUnreachableRedis(): Redis` (`createRedis("redis://127.0.0.1:1")` — a real client that cannot connect, used for Redis-down scenarios; not a mock); `closeRedis(): Promise<void>` |
| `tests/helpers/app.ts` | `buildTestApps(options?: { extraApiRouter?: Router; extraInternalRouter?: Router; overrides?: DependencyOverrides }): { publicApp: Express; internalApp: Express }` — the real `createApp`/`createInternalApp` wiring |
| `tests/helpers/log-capture.ts` | `captureLogs(level?: LogLevel): LogCapture` (`LogCapture { lines(): Record<string, unknown>[]; text(): string; restore(): void }`) — spies `process.stdout.write`, temporarily `logger.setLevel(level ?? "debug")` |
| `tests/helpers/types.ts` | helper option/return types above |
| `tests/helpers/test-routers.ts` | `buildTestRouter(deps): Router` — routes under `/__test`: `POST /echo` (validateBody with a small DTO → `sendSuccess 201`), `GET /boom` (throws `new Error("db password=…")`), `GET /app-error` (throws `Conflict`), `POST /idem` and `POST /idem/:id` (`idempotency({ required: true })`, increments a counter, optional `?delayMs=`), `POST /idem-optional`, `GET /limited` (`rateLimit({ name: "test", limit: 3, windowMs: 1000, subject: clientIp, degrade })`), `GET /page` (buildPage over a fixed array). Mounted only through `extraApiRouter`, never in `src/routes.ts` |

Integration suites truncate tables and `flushTestKeys()` in `beforeEach`, and close pools in `afterAll`.

### 9.2 Unit tests (`tests/unit/`, collaborators mocked, each < 100 ms)

**`lib/config/load-env.test.ts`**
- should apply defaults when optional variables are absent
- should throw naming DATABASE_URL when it is missing
- should throw naming REDIS_URL when it is an empty string
- should never include variable values in the error when parsing fails
- should reject LOG_LEVEL when it is debug and NODE_ENV is production
- should reject INTERNAL_PORT when it equals PORT
- should parse CORS_ORIGINS into a trimmed list when it is comma separated
- should reject CORS_ORIGINS when an entry has a path
- should reject DATABASE_URL when the protocol is not postgres

**`lib/error/app-error.test.ts`**
- should return a new instance with details when withDetails is called
- should leave the shared instance unchanged when withDetails is called

**`lib/error/error-handler.test.ts`**
- should render code status and message when an AppError is passed
- should include details when the AppError has details
- should render details as an empty array when the AppError has none
- should return 400 ValidationFailed on field body when JSON parsing failed
- should return 400 ValidationFailed on field body when the body exceeds the limit
- should return 500 InternalError without the original message when an unknown error is passed
- should log the stack at error level when the error is unknown
- should not log the request body or headers when handling any error
- should delegate to next when headers were already sent
- should put the request id in the body when rendering an error
- should respond 404 NotFound when notFoundHandler runs

**`lib/request-id/request-id.test.ts`**
- should adopt the incoming id lower-cased when X-Request-Id is a UUID
- should generate a UUID when X-Request-Id is not a UUID
- should generate a UUID when X-Request-Id is absent
- should set the response header before calling next
- should expose the id through getRequestContext when inside the request

**`lib/logger/logger.test.ts`**
- should write one JSON line with level message timestamp and service when logging
- should include requestId when called inside a request context
- should drop debug lines when the level is info
- should drop debug lines when production is true
- should not let fields override reserved keys
- should write an EMF metric line when metric is called
- should not throw when fields contain a circular reference

**`lib/logger/redact.test.ts`**
- should redact every listed key when it appears at any depth
- should match keys regardless of case dashes and underscores
- should redact values inside arrays of objects
- should serialise errors to name message and stack when an Error is passed
- should not mutate the input when redacting

**`lib/logger/request-logger.test.ts`**
- should log route pattern status and durationMs when the response finishes
- should log unmatched as route when no route was captured
- should log at error level when the status is 500 or more
- should skip health routes when the status is below 500
- should log status 499 when the client closes before finish

**`lib/http/response.test.ts`**
- should wrap data in the success envelope when sendSuccess is called
- should include meta only when it is provided
- should send 204 without a body when sendNoContent is called
- should set Cache-Control no-store when noStore runs

**`lib/http/cors.test.ts`**
- should set allow-origin credentials and Vary when the origin is allowlisted
- should set no CORS headers when the origin is not allowlisted
- should answer 204 with allow-methods and allow-headers when an allowlisted preflight arrives

**`lib/http/pagination.test.ts`**
- should round-trip the sort value and id when a cursor is encoded then decoded
- should throw ValidationFailed on field cursor when the cursor is not base64url JSON
- should throw ValidationFailed on field cursor when the id is not a positive integer
- should return hasMore true and a nextCursor when rows exceed the limit
- should return nextCursor null and hasMore false when rows do not exceed the limit

**`lib/http/client-ip.test.ts`**
- should strip the IPv4-mapped prefix when the address is IPv4-mapped IPv6

**`lib/validation/validate.test.ts`**
- should return a typed instance when the body is valid
- should throw ValidationFailed with one detail per failing field when validation fails
- should report is not allowed when an unknown property is sent
- should reject the body when it is an array or null
- should use dotted field paths when nested validation fails
- should convert numeric strings when validating a query
- should apply limit 20 when PaginationQueryDto receives no limit

**`lib/idempotency/idempotency.test.ts`** (Redis mocked)
- should respond 400 ValidationFailed when the key is required and missing
- should call next without touching Redis when the key is optional and missing
- should respond 400 ValidationFailed when the key is not a UUID
- should skip and log idempotency_skipped when Redis is not ready
- should skip when a Redis command exceeds 100 ms before the handler
- should store status and body when the handler finishes below 500
- should delete the record when the handler finishes with 500 or more
- should delete the record when the client disconnects before finish
- should replay the stored status and body without running the handler when the same key and body repeat
- should replace error.requestId with the current id when replaying an error body
- should respond 422 IdempotencyConflict when the same key arrives with a different body
- should respond 409 Conflict with Retry-After 1 when the same key and body are still in flight
- should treat bodies as identical when only key order differs
- should build idem:<METHOD> <concrete path>:<principal>:<key> without the query string when composing the Redis key
- should produce different keys when the same Idempotency-Key targets two different resource ids

**`lib/rate-limit/rate-limit.test.ts`** (Redis mocked)
- should call next when the script allows the request
- should respond 429 RateLimited with Retry-After when the script denies the request
- should log rate_limited without the subject when the limiter trips
- should use the in-process limiter at floor(limit / divisor) when Redis is not ready and degrade is fallback
- should fall back when the Redis call exceeds 50 ms
- should never allow fewer than one request when floor(limit / divisor) is zero
- should call next when Redis is unavailable and degrade is fail-open
- should emit rate_limiter_degraded at most once per minute per limiter
- should use Redis again when it becomes ready

**`lib/rate-limit/in-process-limiter.test.ts`**
- should allow up to the limit within the window and deny the next hit
- should allow again when the oldest hit leaves the window
- should evict the oldest key when maxKeys is reached

**`lib/worker/run-loop.test.ts`** (fake timers)
- should run ticks sequentially separated by the interval
- should keep looping and log worker_tick_failed when a tick throws
- should let the current tick finish when stop is called
- should not start another tick after stop
- should return the same promise when stop is called twice

**`pkg/utils/time.test.ts`**
- should convert each unit to milliseconds when toMs is called
- should throw RangeError when the amount is negative or not finite
- should return a new Date when addTime is called

**`app/health/health.service.test.ts`** (db and Redis mocked — infra-failure scenarios are unit tests)
- should report 200 ok when the database and Redis are up
- should report 200 degraded when Redis is down
- should report 503 down when the database is down
- should mark the database down when SELECT 1 exceeds 500 ms
- should report 503 down when shutting down even if dependencies are up
- should report liveness ok when shutting down

**`server.shutdown.test.ts`** (servers, db, Redis mocked)
- should mark not-ready before closing the listeners
- should close both listeners before destroying knex and quitting Redis
- should resolve 0 when the drain completes before the deadline
- should resolve 1 and log shutdown_timeout with the unfinished count when the deadline passes
- should run the sequence once when two signals arrive
- should resolve 1 when the reason is uncaughtException
- should bind the internal listener to INTERNAL_HOST when starting

**`lib/lifecycle/lifecycle.test.ts`**
- should report shutting down after markShuttingDown is called
- should count a request once when both finish and close fire
- should never report a negative in-flight count

**`worker.test.ts`**
- should stop the loop then destroy knex when SIGTERM arrives
- should resolve 1 when the loop does not stop before the deadline

### 9.3 Integration tests (`tests/integration/`, real Postgres + Redis, real wiring)

**`health.test.ts`**
- should return 200 status ok when GET /api/health/live is called
- should return 200 status ok when GET /internal/health/live is called
- should return 200 ok with database up and redis up when GET /api/health/ready is called
- should return 200 ok with database up and redis up when GET /internal/health/ready is called
- should return 200 degraded with redis down when the app uses an unreachable Redis client
- should return 503 down when readiness is called after markShuttingDown
- should carry X-Request-Id and Cache-Control no-store when a health route responds
- should match the HealthLive and HealthStatus contract schemas when health routes respond
- should return 404 NotFound when /internal/health/ready is requested on the public listener
- should return 404 NotFound when /api/health/ready is requested on the internal listener

**`envelope.test.ts`**
- should return the success envelope when a test route succeeds
- should return 404 NotFound envelope with requestId when the path is unknown on either listener
- should return 400 ValidationFailed on field body when the JSON is malformed
- should return 400 ValidationFailed with details when the DTO is invalid
- should return 409 Conflict envelope when a route throws a shared AppError
- should return 500 InternalError without internals when a route throws an unknown error
- should match the ErrorEnvelope contract schema for every error response

**`request-id.test.ts`**
- should echo the incoming UUID when X-Request-Id is valid
- should replace X-Request-Id when it is not a UUID
- should put the same id in the header and error body when a request fails

**`security-headers.test.ts`**
- should send helmet headers and no X-Powered-By on both listeners
- should send CORS headers when the origin is allowlisted on the public listener
- should never send CORS headers on the internal listener

**`idempotency.test.ts`**
- should replay the original status and body without re-running the handler when the same key and body repeat
- should return 422 IdempotencyConflict when the same key is reused with a different body
- should return 400 ValidationFailed when the key is required and missing
- should store the record under idem:POST /api/__test/idem:ip:<ip>:<key> with a TTL of at most 24 h
- should not replay across resources when the same key is sent to /__test/idem/1 and /__test/idem/2
- should run the handler exactly once and answer the other with 409 Conflict when two requests with the same key and body race
- should re-run the handler when the first attempt failed with 500
- should run the handler for each request when Redis is unreachable

**`rate-limit.test.ts`**
- should return 429 RateLimited with Retry-After when the limit is exceeded
- should store hits under rl:test:<subject> when requests are limited
- should allow again when the window has slid past the oldest hit
- should limit at floor(limit / divisor) when Redis is unreachable and degrade is fallback
- should allow every request when Redis is unreachable and degrade is fail-open

**`migrations.test.ts`**
- should have the citext extension installed when migrations have run

**`logging.test.ts`**
- should contain no fixture secret values in captured logs when requests carry Authorization and Cookie headers and a body with password and email
- should log request_completed with the route pattern when a test route responds

**`process.test.ts`** (child processes via `tsx`)
- should serve readiness and exit 0 when the server receives SIGTERM
- should exit 0 when the idle worker receives SIGTERM
- should exit 1 and name the key without its value when DATABASE_URL is missing

### 9.4 CLAUDE.md → Testing policy scenarios that apply
- "with Redis down, readiness stays 200" → health integration (degraded) + unit.
- "idempotent replay and conflict" → idempotency unit + integration.
- "no secret appears in any response body / logs" → envelope 500 test + `logging.test.ts`.
- Contract conformance → health and envelope schema tests (schemas loaded from `contracts/openapi.yaml` with a small
  in-test JSON-schema subset check of `required`/`enum`/`const`; no new dev dependency).
- RBAC, Domain rules, pagination page 2 on a real list: not applicable (no business routes; `buildPage` unit tests
  cover the page mechanics).

---

## 10. Business rules (foundation invariants)

| # | Rule | Enforced by |
|---|---|---|
| F1 | Every response on both listeners carries `X-Request-Id`; a non-UUID incoming value is replaced | `lib/request-id` (first middleware) |
| F2 | Every error response is the one envelope with a contract `ErrorCode` and a `details` array (`[]` when empty); unknown errors are `500 InternalError` with no internals | `lib/error/errorHandler` |
| F3 | Readiness is 503 with `status: "down"` iff Postgres is down or shutdown is in progress; Redis down yields 200 `degraded` | `HealthService.readiness` |
| F4 | Liveness never checks dependencies and is never 503 | `HealthService.liveness` |
| F5 | Same idempotency key + same concrete path + same principal + same body replays; different body → 422; required + missing → 400; concurrent same key → one execution | `lib/idempotency` (Redis `SET NX`) |
| F6 | A Redis outage never fails a request: idempotency skips, limiters fall back or fail open | `lib/idempotency`, `lib/rate-limit` |
| F7 | Fallback limit = `max(1, floor(limit / RATE_LIMIT_FALLBACK_DIVISOR))` per task | `lib/rate-limit` |
| F8 | Listed secret/PII keys are never written unredacted to logs; bodies and headers are never logged | `lib/logger/redact`, `requestLogger`, `errorHandler` |
| F9 | Invalid env stops the process with exit 1, naming keys only; secrets have no defaults | `lib/config` |
| F10 | Shutdown: not-ready → close listeners → drain ≤ `SHUTDOWN_TIMEOUT_MS` → destroy pool, quit Redis → exit 0 (1 on timeout) | `src/server.ts` |
| F11 | The internal listener binds `INTERNAL_HOST`; `/internal/*` is never served by the public app and vice versa | `src/server.ts`, `src/app.ts`, ESLint |
| F12 | Every pooled connection is UTC with a 2 s statement timeout; migrations run without a timeout | `lib/knex` |
| F13 | Forbidden libraries and layering violations fail lint | `eslint.config.mjs`, CI |

Each rule maps to at least one named test in §9.

---

## 11. Cross-service behavior, errors, security, performance

### 11.1 Cross-service behavior
None. The foundation makes and serves no cross-service calls. `/internal/health/*` is probed by the internal LB only.

### 11.2 ADR the developer writes first — `docs/adr/0015-foundation-runtime-dependencies.md`
Frontmatter per CLAUDE.md → Documentation structure (`status: accepted`, `date: 2026-09-15`). Content:
- **Context:** CLAUDE.md → Tech stack requires an ADR for any runtime dependency outside the locked list.
- **Decision:** (1) add `reflect-metadata` — required polyfill for `tsyringe` decorators; (2) **no `cors`** — an
  in-house allowlist middleware (§4.7), because CORS is dev-only (hub ADR 0005) and the logic is ~30 lines;
  (3) **no `uuid`** — `crypto.randomUUID()`; (4) **no `dotenv`** — Node's `--env-file-if-exists` / `process.loadEnvFile`;
  (5) `tsx` is a dev dependency only; esbuild emits no decorator metadata, so all injections use explicit `@inject` tokens.
- **Consequences / alternatives:** the `cors` package (rejected: extra dependency for dev-only behaviour);
  `ts-node` (rejected: slower, still a dev tool).
- Add the INDEX row for it.

### 11.3 Error codes
Used by the foundation (all already in the contract and CLAUDE.md → API conventions; **no new codes**):

| Code | HTTP | When (in the foundation) |
|---|---|---|
| `ValidationFailed` | 400 | DTO validation; malformed/oversized/unsupported JSON body; bad cursor; missing (required) or non-UUID `Idempotency-Key` |
| `Unauthorized` | 401 | declared only (used by later guards) |
| `Forbidden` | 403 | declared only |
| `NotFound` | 404 | no route matched |
| `Conflict` | 409 | idempotent request with the same key still in flight (also generic for modules) |
| `IdempotencyConflict` | 422 | same key, different body |
| `RateLimited` | 429 | limiter tripped (with `Retry-After`) |
| `InternalError` | 500 | unhandled error |

### 11.4 Security & privacy
- RBAC: no protected routes; health is the documented probe exception. `lib/rbac` lands with the first business module.
- Audit: none (Identity's audit trail is `user_status_changes`, owned by `users`).
- Never logged: request bodies, headers (incl. `Authorization`, `Cookie`), query strings, raw URLs, rate-limit subjects,
  idempotency keys, env values, Redis/Postgres URLs.
- `helmet` on both listeners (HSTS in production on the public listener); CORS dev-only on the public listener.
- JSON body limit 100 kb; `x-powered-by` disabled; `trust proxy` = `TRUST_PROXY_HOPS` (0 locally) so `req.ip` cannot
  be spoofed with `X-Forwarded-For` unless a proxy hop is configured.
- Internal listener binds `INTERNAL_HOST` (default `127.0.0.1`).
- Container runs as `node` (non-root); no secrets in the image.
- Files/uploads: none.

### 11.5 Performance
- Per-request overhead: request id + ALS + logger line + helmet + JSON parse — no I/O.
- Readiness: 2 concurrent checks, each bounded at 500 ms → worst case ~500 ms; liveness no I/O.
- Rate limiter: one Lua `EVALSHA` per limiter per request, bounded at 50 ms before fallback.
- Idempotency: 1–2 Redis round trips before the handler, 1 after (async), bounded at 100 ms before skipping.
- Pool: `acquireTimeoutMillis: 1000` (fast-fail on pool wait, deployment.md bottleneck 4); statement timeout 2 s.
- No queries other than `SELECT 1`; nothing to `EXPLAIN`.

---

## 12. Docs to update after the build (`/update-docs foundation`)

| Doc | Change |
|---|---|
| `docs/architecture/infrastructure.md` | §1: add `TRUST_PROXY_HOPS`; mark which variables exist as of the foundation. §2: redaction mechanics (normalized key match, depth, circular) + the extra keys from §4.6; `metric()` line. §5: remove "current contract" note — live/ready is as-built. §6: exact sequence incl. `closeIdleConnections`, exit code 1 on uncaught errors. §7: idempotency behaviour table (in-flight `409 Conflict`), limiter degrade modes. §8: pool acquire timeout 1 s |
| `docs/quickstart.md` | Postgres **17**; `docker compose up`; `npm run dev` / `dev:worker` (not `npm run worker`); health URLs `/api/health/ready`, `/internal/health/ready`; `.env` foundation subset; test commands |
| `docs/architecture/overview.md` | container diagram health paths; request pipeline order (inflight → request id → request logger → helmet → CORS → JSON → routes → 404 → error handler; rate limit and idempotency are route-level); `src/bootstrap.ts`, `src/migrate.ts`, `lib/lifecycle/`, and `lib/worker/` in the module/lib list |
| `docs/architecture/api.md` | health tag rows → four live/ready operations; exceptions row |
| `docs/runbook.md` | health rows → live/ready as-built |
| `docs/service-card.md` | **affected**: status "foundation built"; endpoint family `health` → `/api/health/live|ready`, `/internal/health/live|ready` |
| `docs/INDEX.md` | module rows for `foundation/brainstorm.md` and `foundation/spec.md` (added by this spec), later `tasks.md`; ADR 0015 row |
| `CLAUDE.md` | Folder structure (standard layout — being written by the orchestrator): `src/bootstrap.ts`, `src/migrate.ts`, `src/worker.ts`, `lib/lifecycle/`, `lib/worker/`, `lib/http/` helpers `cors.ts`, `no-store.ts`, `client-ip.ts`; verify it matches this spec |
| Hub | run `../vcare-hub/scripts/sync-from-spoke.sh` after the contract change (card + contract) |

**Care parity checklist (decided 2026-09-15; both specs must match):**
- Envelope: key order `success`, `code`, `message`, `details`, `requestId`; `details` **always** present, `[]` when empty.
- `X-Request-Id`: UUID regex, adopted lower-cased, else `crypto.randomUUID()`; request id via AsyncLocalStorage.
- Health: liveness `{ status: "ok" }`; readiness `{ status: ok|degraded|down, checks: { database: up|down, redis: up|down } }`,
  503 ⇔ `status: "down"` (Postgres down or shutting down); schemas `HealthLive`, `HealthStatus`.
- Idempotency key `idem:<METHOD> <concrete baseUrl+path>:<user:id|client:id|ip:addr>:<lower-cased uuid>` (no query
  string, never the route pattern); in-flight duplicate → `409 Conflict` + `Retry-After: 1`; in-flight TTL 60 s;
  `error.requestId` rewritten on replay.
- Rate-limit key `rl:<name>:<subject>`; Lua sliding-window log on Redis `TIME`; degrade modes `fallback` / `fail-open`.
- Redaction: normalized key match (lower-case, strip `-`/`_`), depth 8, `"[REDACTED]"`; logger `metric()` (EMF).
- Dev runner `tsx`; explicit `@inject` on every constructor parameter.
- Layout: `src/bootstrap.ts`, `src/migrate.ts`, `src/worker.ts`, `lib/lifecycle/`, `lib/worker/`, `lib/http/{cors,no-store,client-ip}.ts`.
- `sendSuccess` / `sendNoContent` / `sendRaw` signatures.

---

## 13. Out of scope
`lib/auth` (jwt, jwks, guards), `lib/rbac`, `lib/email`, `lib/outbox` and job handlers, `pkg/utils/crypto.ts`,
`isPast`, argon2 / bcrypt / `jose`, the hash semaphore, any business table, route, or env variable (JWT, OTP, email,
hash, outbox), `/.well-known/jwks.json`, request-level `http_requests`/`http_latency_ms` metrics and `db_pool_*`
metrics (added with the observability work that needs them), OpenTelemetry (ADR 0013), a docker image push or deploy.

## 14. Open questions
None. Parity decisions with care-service were approved on 2026-09-15 (§12 checklist). Remaining defaults are
minor and reviewable: the `TRUST_PROXY_HOPS` env var, and the redaction additions in §4.6.
