/**
 * The RBAC vocabulary. `lib/` cannot import `app/`, so the role and status literals live here and
 * `app/auth/enums.ts` (whose values match the database CHECK constraints) is asserted against them in a
 * unit test, so the two can never drift (spec §3.1).
 */
export type Role = "patient" | "doctor" | "admin";
export type AccountStatus = "pending" | "active" | "suspended" | "rejected";

/**
 * Deny by default (CLAUDE.md -> Authorization — RBAC and ownership). Roles are always listed explicitly;
 * there is no "any authenticated user" wildcard, so a new role gets no access until a policy names it
 * (ADR 0010). Epic B adds `{ kind: "service"; scope: string; owner: "none" }`.
 */
export type Policy =
  /** No principal at all (registration, login, password flows, JWKS). */
  | { kind: "public"; owner: "none" }
  /**
   * The principal is the presented refresh cookie's token row, resolved in `SessionService`, which only ever
   * acts on that token's own family. No `roles`: the contract declares `x-roles: [public]` for refresh and
   * logout and `authorize` never evaluates roles for this kind.
   */
  | { kind: "refresh-cookie"; owner: "refresh-family" }
  /** A verified user access token; `self` routes take no id and act only on `req.auth.userId`. */
  | {
      kind: "user";
      roles: readonly Role[];
      owner: "self" | "none";
      allowedStatuses: readonly AccountStatus[];
    };

/** Minimal view of an Express 5 router layer, used only by `assertRoutesAuthorized`. */
export interface StackLayer {
  name?: string;
  handle?: unknown;
  route?: {
    path?: unknown;
    methods?: Record<string, boolean>;
    stack?: readonly { handle?: unknown }[];
  };
}

export const ROLES: readonly Role[] = ["patient", "doctor", "admin"];
export const ACCOUNT_STATUSES: readonly AccountStatus[] = [
  "pending",
  "active",
  "suspended",
  "rejected",
];

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === "string" && (ACCOUNT_STATUSES as readonly string[]).includes(value);
}
