/**
 * Shared argument validation and SQL builder for the service-client scripts (docs/service-auth/spec.md section 6).
 * Pure: no database, no environment, no I/O, so it is unit-tested. The patterns and the scope vocabulary are the
 * ones of the `service_clients` migration, so a value that passes here also passes the table's CHECKs.
 *
 * Errors name the offending **argument**, never a value (a mistyped secret must not end up in a terminal log).
 */
import {
  CONTACT_SCOPE,
  CONTACT_SCOPE_CLIENT_ID,
  SERVICE_CLIENT_ID_PATTERN,
  SERVICE_SCOPES,
} from "../src/lib/auth/constants";

export const DEFAULT_OVERLAP_HOURS = 24;
export const MAX_OVERLAP_HOURS = 168;
const NAME_MAX_LENGTH = 120;
const AUDIENCE_PATTERN = /^vcare-[a-z0-9-]+$/;

export interface NewClientArgs {
  mode: "new";
  clientId: string;
  name: string;
  scopes: string[];
  audiences: string[];
}

export interface RotateArgs {
  mode: "rotate";
  clientId: string;
  /** `null` = `--leaked`: the old secret stops working at once. */
  overlapHours: number | null;
}

export type ProvisionArgs = NewClientArgs | RotateArgs;

export interface SeedArgs {
  clientId: string;
  name: string;
  scopes: string[];
  audiences: string[];
}

export class ArgumentError extends Error {}

const FLAGS_WITH_VALUE = ["client-id", "name", "scopes", "audiences", "overlap-hours"];
const BOOLEAN_FLAGS = ["rotate", "leaked"];

interface RawArgs {
  values: Map<string, string>;
  flags: Set<string>;
}

function readRaw(argv: readonly string[], allowed: readonly string[]): RawArgs {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (!token.startsWith("--")) {
      throw new ArgumentError("unexpected positional argument");
    }
    const name = token.slice(2);
    if (!allowed.includes(name)) {
      throw new ArgumentError(`unknown argument --${name}`);
    }
    if (BOOLEAN_FLAGS.includes(name)) {
      flags.add(name);
      continue;
    }
    if (!FLAGS_WITH_VALUE.includes(name)) {
      throw new ArgumentError(`unknown argument --${name}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ArgumentError(`--${name} needs a value`);
    }
    if (values.has(name)) {
      throw new ArgumentError(`--${name} was given twice`);
    }
    values.set(name, value);
    index += 1;
  }
  return { values, flags };
}

function requireClientId(raw: RawArgs): string {
  const clientId = raw.values.get("client-id");
  if (clientId === undefined) {
    throw new ArgumentError("--client-id is required");
  }
  if (!SERVICE_CLIENT_ID_PATTERN.test(clientId)) {
    throw new ArgumentError("--client-id must match ^[a-z][a-z0-9-]{2,63}$");
  }
  return clientId;
}

function words(value: string): string[] {
  return [...new Set(value.split(" ").filter((entry) => entry.length > 0))];
}

function parseName(value: string | undefined): string {
  if (value === undefined) {
    throw new ArgumentError("--name is required");
  }
  const name = value.trim();
  if (name.length === 0 || name.length > NAME_MAX_LENGTH) {
    throw new ArgumentError(`--name must be 1 to ${String(NAME_MAX_LENGTH)} characters`);
  }
  return name;
}

function parseScopes(value: string | undefined): string[] {
  if (value === undefined) {
    throw new ArgumentError("--scopes is required");
  }
  const scopes = words(value);
  if (scopes.length === 0) {
    throw new ArgumentError("--scopes needs at least one scope");
  }
  if (!scopes.every((scope) => (SERVICE_SCOPES as readonly string[]).includes(scope))) {
    throw new ArgumentError(`--scopes must be a subset of: ${SERVICE_SCOPES.join(" ")}`);
  }
  return scopes;
}

/** ADR 0024: the contact scope is care-service only; the table CHECK is the guarantee, this is the clear message. */
function assertContactScopeAllowed(clientId: string, scopes: readonly string[]): void {
  if (scopes.includes(CONTACT_SCOPE) && clientId !== CONTACT_SCOPE_CLIENT_ID) {
    throw new ArgumentError(`--scopes: ${CONTACT_SCOPE} can only be granted to ${CONTACT_SCOPE_CLIENT_ID}`);
  }
}

function parseAudiences(value: string | undefined): string[] {
  if (value === undefined) {
    throw new ArgumentError("--audiences is required");
  }
  const audiences = words(value);
  if (audiences.length === 0 || !audiences.every((audience) => AUDIENCE_PATTERN.test(audience))) {
    throw new ArgumentError("--audiences must be space-separated values matching ^vcare-[a-z0-9-]+$");
  }
  return audiences;
}

function parseOverlap(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new ArgumentError("--overlap-hours must be a whole number");
  }
  const hours = Number(value);
  if (hours < 1 || hours > MAX_OVERLAP_HOURS) {
    throw new ArgumentError(`--overlap-hours must be between 1 and ${String(MAX_OVERLAP_HOURS)}`);
  }
  return hours;
}

/** `scripts/provision-service-client.ts`: a new client (default) or `--rotate [--overlap-hours N | --leaked]`. */
export function parseProvisionArgs(argv: readonly string[]): ProvisionArgs {
  const raw = readRaw(argv, ["client-id", "name", "scopes", "audiences", "rotate", "overlap-hours", "leaked"]);
  const clientId = requireClientId(raw);

  if (!raw.flags.has("rotate")) {
    if (raw.flags.has("leaked") || raw.values.has("overlap-hours")) {
      throw new ArgumentError("--leaked and --overlap-hours need --rotate");
    }
    const name = parseName(raw.values.get("name"));
    const scopes = parseScopes(raw.values.get("scopes"));
    assertContactScopeAllowed(clientId, scopes);
    return {
      mode: "new",
      clientId,
      name,
      scopes,
      audiences: parseAudiences(raw.values.get("audiences")),
    };
  }

  for (const flag of ["name", "scopes", "audiences"]) {
    if (raw.values.has(flag)) {
      throw new ArgumentError(`--${flag} cannot be combined with --rotate`);
    }
  }
  const overlap = raw.values.get("overlap-hours");
  if (raw.flags.has("leaked")) {
    if (overlap !== undefined) {
      throw new ArgumentError("--leaked cannot be combined with --overlap-hours");
    }
    return { mode: "rotate", clientId, overlapHours: null };
  }
  return {
    mode: "rotate",
    clientId,
    overlapHours: overlap === undefined ? DEFAULT_OVERLAP_HOURS : parseOverlap(overlap),
  };
}

/** `scripts/seed-service-client.ts`: every argument has a local-dev default. */
export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  const raw = readRaw(argv, ["client-id", "name", "scopes", "audiences"]);
  const clientId = raw.values.has("client-id") ? requireClientId(raw) : CONTACT_SCOPE_CLIENT_ID;
  const defaultScopes =
    clientId === CONTACT_SCOPE_CLIENT_ID
      ? `users:read users:status:write ${CONTACT_SCOPE}`
      : "users:read users:status:write";
  const scopes = parseScopes(raw.values.get("scopes") ?? defaultScopes);
  assertContactScopeAllowed(clientId, scopes);
  return {
    clientId,
    name: parseName(raw.values.get("name") ?? "Care service (local)"),
    scopes,
    audiences: parseAudiences(raw.values.get("audiences") ?? "vcare-identity"),
  };
}

/** The seed script is a local-development convenience and must never touch a production database. */
export function assertSeedAllowed(nodeEnv: string | undefined): void {
  if (nodeEnv === "production") {
    throw new ArgumentError("seed:service-client refuses to run when NODE_ENV=production");
  }
}

/** Every interpolated value was validated above (no quote can survive), but quotes are doubled regardless. */
export function sqlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlTextArray(values: readonly string[]): string {
  return `ARRAY[${values.map(sqlLiteral).join(", ")}]::text[]`;
}

export function buildInsertSql(args: NewClientArgs, secretHash: string): string {
  return (
    "INSERT INTO service_clients " +
    "(client_id, name, client_secret_hash, allowed_scopes, allowed_audiences, is_active, created_at, updated_at) " +
    `VALUES (${sqlLiteral(args.clientId)}, ${sqlLiteral(args.name)}, ${sqlLiteral(secretHash)}, ` +
    `${sqlTextArray(args.scopes)}, ${sqlTextArray(args.audiences)}, true, now(), now());`
  );
}

export function buildRotateSql(args: RotateArgs, secretHash: string): string {
  const previous =
    args.overlapHours === null
      ? "previous_secret_hash = NULL, previous_secret_expires_at = NULL"
      : `previous_secret_hash = client_secret_hash, previous_secret_expires_at = now() + interval '${String(args.overlapHours)} hours'`;

  return (
    `UPDATE service_clients SET ${previous}, ` +
    `client_secret_hash = ${sqlLiteral(secretHash)}, secret_rotated_at = now(), updated_at = now() ` +
    `WHERE client_id = ${sqlLiteral(args.clientId)} AND deleted_at IS NULL;`
  );
}

/** Postgres array literal for a bound parameter (`?::text[]`); values are validated, so no quoting is needed. */
export function pgArrayLiteral(values: readonly string[]): string {
  return `{${values.join(",")}}`;
}
