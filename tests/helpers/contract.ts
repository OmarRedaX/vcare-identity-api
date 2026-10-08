import fs from "node:fs";
import path from "node:path";

/**
 * Contract conformance (CLAUDE.md -> Testing policy): the asserted status codes, error codes and shapes are
 * read from contracts/openapi.yaml itself, so drift between code and contract fails a test instead of being
 * silently accepted. Only the few facts the foundation needs are extracted — no YAML dependency is added.
 */
const CONTRACT = fs.readFileSync(path.resolve(process.cwd(), "contracts", "openapi.yaml"), "utf8");

/** The body of `components.schemas.<name>` (everything indented under the 4-space schema key). */
export function schemaBlock(name: string): string {
  const lines = CONTRACT.split(/\r?\n/);
  const start = lines.indexOf(`    ${name}:`);
  if (start < 0) {
    throw new Error(`schema ${name} is missing from contracts/openapi.yaml`);
  }

  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^ {0,4}\S/.test(line));
  return rest.slice(0, end < 0 ? rest.length : end).join("\n");
}

/** `key: [a, b, c]` */
export function inlineList(block: string, key: string): string[] {
  const match = new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`).exec(block);
  if (!match?.[1]) {
    throw new Error(`inline list ${key} not found`);
  }
  return match[1]
    .split(",")
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
    .filter((entry) => entry.length > 0);
}

/** Every `key: [...]` occurrence inside the block, outermost first (a schema and its nested objects). */
export function inlineLists(block: string, key: string): string[][] {
  return [...block.matchAll(new RegExp(`${key}:\\s*\\[([^\\]]*)\\]`, "g"))].map((match) =>
    (match[1] ?? "")
      .split(",")
      .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ""))
      .filter((entry) => entry.length > 0),
  );
}

/** `key:` followed by `- value` lines. */
export function blockList(block: string, key: string): string[] {
  const lines = block.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start < 0) {
    throw new Error(`block list ${key} not found`);
  }

  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("- ")) {
      values.push(trimmed.slice(2).trim().replace(/^['"]|['"]$/g, ""));
      continue;
    }
    if (trimmed.length > 0) {
      break;
    }
  }
  return values;
}

export interface ContractOperation {
  statuses: string[];
  /** Header names declared inline per status (a `$ref` response contributes no inline headers). */
  headersByStatus: Record<string, string[]>;
  errorCodes: string[];
}

/** The declared status codes, inline response headers and `x-error-codes` of one operation. */
export function contractOperation(pathName: string, method: string): ContractOperation {
  const lines = CONTRACT.split(/\r?\n/);
  const pathStart = lines.indexOf(`  ${pathName}:`);
  if (pathStart < 0) {
    throw new Error(`path ${pathName} is missing from contracts/openapi.yaml`);
  }
  const afterPath = lines.slice(pathStart + 1);
  const pathEnd = afterPath.findIndex((line) => /^ {0,2}\S/.test(line));
  const pathLines = afterPath.slice(0, pathEnd < 0 ? afterPath.length : pathEnd);

  const opStart = pathLines.indexOf(`    ${method}:`);
  if (opStart < 0) {
    throw new Error(`${method} ${pathName} is missing from contracts/openapi.yaml`);
  }
  const afterOp = pathLines.slice(opStart + 1);
  const opEnd = afterOp.findIndex((line) => /^ {0,4}\S/.test(line));
  const opLines = afterOp.slice(0, opEnd < 0 ? afterOp.length : opEnd);

  const errorLine = opLines.find((line) => line.trim().startsWith("x-error-codes:")) ?? "";
  const errorCodes = (/\[([^\]]*)\]/.exec(errorLine)?.[1] ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  const responsesStart = opLines.indexOf("      responses:");
  const statuses: string[] = [];
  const headersByStatus: Record<string, string[]> = {};
  let current: string | undefined;
  let inHeaders = false;
  for (const line of opLines.slice(responsesStart + 1)) {
    const status = /^ {8}'(\d{3})':/.exec(line);
    if (status?.[1]) {
      current = status[1];
      statuses.push(current);
      headersByStatus[current] = [];
      inHeaders = false;
      continue;
    }
    if (current === undefined) {
      continue;
    }
    if (/^ {10}headers:/.test(line)) {
      inHeaders = true;
      continue;
    }
    if (/^ {10}\S/.test(line)) {
      inHeaders = false;
    }
    const header = /^ {12}([A-Za-z-]+):/.exec(line);
    if (inHeaders && header?.[1]) {
      headersByStatus[current]?.push(header[1]);
    }
  }
  return { statuses, headersByStatus, errorCodes };
}

export function contractErrorCodes(): string[] {
  return blockList(schemaBlock("ErrorCode"), "enum");
}

export function contractHealthStatusValues(): string[] {
  return inlineList(schemaBlock("HealthStatus"), "enum");
}

export function contractDependencyStates(dependency: "database" | "redis" = "database"): string[] {
  const block = schemaBlock("HealthStatus");
  const states = new RegExp(`${dependency}:\\s*\\{[^}]*enum:\\s*\\[([^\\]]*)\\]`).exec(block);
  if (!states?.[1]) {
    throw new Error(`HealthStatus.checks.${dependency} enum not found`);
  }
  return states[1].split(",").map((entry) => entry.trim());
}

export function contractHealthLiveConst(): string {
  const match = /const:\s*(\S+)\s*\}?/.exec(schemaBlock("HealthLive"));
  if (!match?.[1]) {
    throw new Error("HealthLive.status const not found");
  }
  return match[1].replace(/[},]/g, "");
}

export function contractRequired(schema: string): string[] {
  return inlineList(schemaBlock(schema), "required");
}

/** Asserts the one error envelope of CLAUDE.md -> API conventions against the contract. */
export function expectErrorEnvelope(body: unknown, expectedCode: string): void {
  const envelope = body as {
    success: boolean;
    error: { code: string; message: string; details: unknown[]; requestId: string };
  };

  // ErrorEnvelope declares `required` twice: once for the envelope, once for the nested error object.
  const [envelopeRequired = [], errorRequired = []] = inlineLists(schemaBlock("ErrorEnvelope"), "required");

  for (const key of envelopeRequired) {
    expect(Object.keys(envelope)).toContain(key);
  }
  expect(envelope.success).toBe(false);
  for (const key of errorRequired) {
    expect(Object.keys(envelope.error)).toContain(key);
  }
  expect(contractErrorCodes()).toContain(envelope.error.code);
  expect(envelope.error.code).toBe(expectedCode);
  expect(typeof envelope.error.message).toBe("string");
  expect(Array.isArray(envelope.error.details)).toBe(true);
  expect(envelope.error.requestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
}

/** Asserts a readiness body against contracts/openapi.yaml -> HealthStatus. */
export function expectHealthStatusBody(body: unknown, httpStatus: number): void {
  const parsed = body as { status: string; checks: { database: string; redis: string } };

  for (const key of contractRequired("HealthStatus")) {
    expect(Object.keys(parsed)).toContain(key);
  }
  expect(contractHealthStatusValues()).toContain(parsed.status);
  expect(contractDependencyStates()).toContain(parsed.checks.database);
  expect(contractDependencyStates("redis")).toContain(parsed.checks.redis);
  expect(parsed.status === "down").toBe(httpStatus === 503);
}

// ── auth (module: auth) ─────────────────────────────────────────────────────

/** The two `vcare_rt` examples the contract fixes, in file order: set, then clear. */
function contractCookieExamples(): { set: string; clear: string } {
  const examples = [...CONTRACT.matchAll(/'(vcare_rt=[^']*)'/g)].map((match) => match[1] ?? "");
  const [set, clear] = examples;
  if (set === undefined || clear === undefined) {
    throw new Error("the vcare_rt cookie examples are missing from contracts/openapi.yaml");
  }
  return { set, clear };
}

function attributesOf(cookie: string): string[] {
  return cookie
    .split(";")
    .slice(1)
    .map((part) => part.trim());
}

/** Asserts a Set-Cookie header against the contract's SetRefreshCookie / ClearRefreshCookie examples. */
export function expectRefreshCookie(header: string | undefined, kind: "set" | "clear"): string {
  expect(typeof header).toBe("string");
  const cookie = header ?? "";
  const examples = contractCookieExamples();
  const example = kind === "set" ? examples.set : examples.clear;

  expect(attributesOf(cookie)).toEqual(attributesOf(example));
  const value = cookie.slice("vcare_rt=".length).split(";")[0] ?? "";
  if (kind === "clear") {
    expect(value).toBe("");
  } else {
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }
  return value;
}

/** Asserts the success envelope of CLAUDE.md -> API conventions and returns `data`. */
export function expectSuccessEnvelope(body: unknown): unknown {
  const envelope = body as { success: boolean; data: unknown };
  for (const key of contractRequired("SuccessEnvelope")) {
    expect(Object.keys(envelope)).toContain(key);
  }
  expect(envelope.success).toBe(true);
  return envelope.data;
}

/** Asserts a `User` payload against contracts/openapi.yaml -> schemas.User. */
export function expectUserPayload(data: unknown): Record<string, unknown> {
  const user = data as Record<string, unknown>;
  expect(Object.keys(user).sort()).toEqual([...contractRequired("User")].sort());
  expect(typeof user.id).toBe("number");
  expect(contractRoles()).toContain(user.role);
  expect(contractStatuses()).toContain(user.status);
  return user;
}

export function contractRoles(): string[] {
  return inlineList(schemaBlock("UserRole"), "enum");
}

export function contractStatuses(): string[] {
  return inlineList(schemaBlock("UserStatus"), "enum");
}

/** Asserts an `AccessTokenResponse` payload (also the base of `LoginResponse`). */
export function expectAccessTokenPayload(data: unknown): string {
  const payload = data as { accessToken: string; tokenType: string; expiresIn: number };
  for (const key of contractRequired("AccessTokenResponse")) {
    expect(Object.keys(payload)).toContain(key);
  }
  expect(payload.tokenType).toBe("Bearer");
  expect(payload.expiresIn).toBe(900);
  expect(typeof payload.accessToken).toBe("string");
  return payload.accessToken;
}

/** Asserts a bare JWK Set against contracts/openapi.yaml -> schemas.Jwks / Jwk. */
export function expectJwksDocument(body: unknown): void {
  const document = body as { keys: Record<string, unknown>[] };
  for (const key of contractRequired("Jwks")) {
    expect(Object.keys(document)).toContain(key);
  }
  expect(document.keys.length).toBeGreaterThanOrEqual(1);
  for (const jwk of document.keys) {
    expect(Object.keys(jwk).sort()).toEqual([...contractRequired("Jwk")].sort());
  }
}

// ── users (module: users) ───────────────────────────────────────────────────

/** Asserts `meta` against contracts/openapi.yaml -> schemas.PaginationMeta. */
export function expectPaginationMeta(meta: unknown): {
  nextCursor: string | null;
  hasMore: boolean;
  count: number;
} {
  const parsed = meta as { nextCursor: string | null; hasMore: boolean; count: number };
  expect(Object.keys(parsed).sort()).toEqual([...contractRequired("PaginationMeta")].sort());
  expect(parsed.nextCursor === null || typeof parsed.nextCursor === "string").toBe(true);
  expect(typeof parsed.hasMore).toBe("boolean");
  expect(Number.isInteger(parsed.count)).toBe(true);
  expect(parsed.count).toBeGreaterThanOrEqual(0);
  expect(parsed.nextCursor === null).toBe(!parsed.hasMore);
  return parsed;
}

/** Asserts a `Session` payload against contracts/openapi.yaml -> schemas.Session. */
export function expectSessionPayload(data: unknown): Record<string, unknown> {
  const session = data as Record<string, unknown>;
  expect(Object.keys(session).sort()).toEqual([...contractRequired("Session")].sort());
  expect(session.familyId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  expect(session.deviceInfo === null || typeof session.deviceInfo === "string").toBe(true);
  for (const field of ["createdAt", "lastUsedAt", "expiresAt"]) {
    expect(new Date(String(session[field])).toISOString()).toBe(session[field]);
  }
  return session;
}

/** Asserts a `StatusChangeResponse` payload against contracts/openapi.yaml -> schemas.StatusChangeResponse. */
export function expectStatusChangePayload(data: unknown): { id: number; status: string; updatedAt: string } {
  const payload = data as { id: number; status: string; updatedAt: string };
  expect(Object.keys(payload).sort()).toEqual([...contractRequired("StatusChangeResponse")].sort());
  expect(typeof payload.id).toBe("number");
  expect(contractStatuses()).toContain(payload.status);
  expect(new Date(payload.updatedAt).toISOString()).toBe(payload.updatedAt);
  return payload;
}

/**
 * The operation must declare the status (and, for an error, list the code in `x-error-codes`), so a status or
 * error code the code returns but the contract does not list fails here instead of being accepted silently.
 */
export function expectContractDeclares(
  pathName: string,
  method: string,
  status: number,
  errorCode?: string,
): void {
  const operation = contractOperation(pathName, method);
  expect(operation.statuses).toContain(String(status));
  if (errorCode !== undefined) {
    expect(operation.errorCodes).toContain(errorCode);
  }
}
