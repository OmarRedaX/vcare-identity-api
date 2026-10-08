import type { AppError } from "../../lib/error/AppError";
import type { UserStatus } from "../auth/enums";
import type { StatusCaller } from "./enums";

/** Every non-entity type of the module (CLAUDE.md -> Module file conventions, item 11). */

/** D-1: one transition method, two caller kinds. `actorUserId` of a service caller is recorded as data only. */
export type StatusChangeCaller =
  | { kind: StatusCaller.Admin; actorUserId: number }
  | { kind: StatusCaller.Service; actorService: string; actorUserId: number };

export interface StatusChangeCommand {
  targetId: number;
  toStatus: UserStatus;
  reason: string;
  caller: StatusChangeCaller;
  requestId: string;
}

/** `changed` is false for the same-status no-op (200, nothing written). */
export interface StatusChangeResult {
  id: number;
  status: UserStatus;
  updatedAt: Date;
  changed: boolean;
}

/** A failed target rule of the status route: the error to throw and the cause to log. */
export interface TargetRefusal {
  error: AppError;
  cause: "self" | "admin" | "doctor" | "role";
}

// ── database row and insert shape ──
export interface UserStatusChangeRow {
  id: string | number;
  user_id: string | number;
  from_status: string;
  to_status: string;
  actor_user_id: string | number | null;
  actor_service: string | null;
  reason: string;
  request_id: string;
  created_at: Date;
}

export interface NewStatusChange {
  userId: number;
  fromStatus: UserStatus;
  toStatus: UserStatus;
  actorUserId: number | null;
  actorService: string | null;
  reason: string;
  requestId: string;
}
