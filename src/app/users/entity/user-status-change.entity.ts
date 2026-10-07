import type { UserStatus } from "../../auth/enums";

/** One row of the append-only status history. Written, never read over the API in MVP. */
export class UserStatusChange {
  id!: number;
  userId!: number;
  fromStatus!: UserStatus;
  toStatus!: UserStatus;
  actorUserId!: number | null;
  actorService!: string | null;
  reason!: string;
  requestId!: string;
  createdAt!: Date;

  constructor(data: Partial<UserStatusChange>) {
    Object.assign(this, data);
  }
}
