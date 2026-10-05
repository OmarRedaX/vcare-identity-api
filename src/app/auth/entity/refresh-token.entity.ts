import { isPast } from "../../../pkg/utils/time";
import type { RevokedReason } from "../enums";

/** One issued refresh token. Only `tokenHash` (sha256 of the 256-bit value) is ever stored or carried. */
export class RefreshToken {
  id!: number;
  userId!: number;
  familyId!: string;
  tokenHash!: string;
  expiresAt!: Date;
  revokedAt!: Date | null;
  revokedReason!: RevokedReason | null;
  replacedById!: number | null;
  deviceInfo!: string | null;
  createdAt!: Date;

  constructor(data: Partial<RefreshToken>) {
    Object.assign(this, data);
  }

  isLive(now: Date): boolean {
    return this.revokedAt === null && !isPast(this.expiresAt, now);
  }
}
