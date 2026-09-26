import type { AccountStatus, Role } from "../rbac/types";

/** Set only by `lib/auth/user-guard.ts` from a verified bearer token — never from a header or body. */
export interface UserAuth {
  kind: "user";
  userId: number;
  role: Role;
  status: AccountStatus;
  ev: boolean;
}

export interface ServiceAuth {
  kind: "service";
  clientId: string;
  scopes: readonly string[];
}

export type RequestAuth = UserAuth | ServiceAuth;
