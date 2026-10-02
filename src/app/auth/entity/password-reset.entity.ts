import { isPast } from "../../../pkg/utils/time";

/**
 * One forgot-password request. `codeHash` is `HMAC-SHA256(OTP_PEPPER, code)` and is `null` until the worker
 * has generated and sent the 6-digit code (ADR 0017).
 */
export class PasswordReset {
  id!: number;
  userId!: number;
  codeHash!: string | null;
  attempts!: number;
  expiresAt!: Date | null;
  usedAt!: Date | null;
  invalidatedAt!: Date | null;
  createdAt!: Date;

  constructor(data: Partial<PasswordReset>) {
    Object.assign(this, data);
  }

  isUsable(now: Date): boolean {
    return (
      this.codeHash !== null &&
      this.expiresAt !== null &&
      this.usedAt === null &&
      this.invalidatedAt === null &&
      !isPast(this.expiresAt, now)
    );
  }
}
