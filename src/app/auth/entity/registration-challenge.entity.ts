import { isPast } from "../../../pkg/utils/time";

/**
 * Proof of email ownership before the account exists (ADR 0006). `codeHash` is
 * `HMAC-SHA256(OTP_PEPPER, code)`, `null` until the worker has sent the 6-digit code.
 */
export class RegistrationChallenge {
  id!: number;
  email!: string;
  codeHash!: string | null;
  attempts!: number;
  expiresAt!: Date | null;
  consumedAt!: Date | null;
  invalidatedAt!: Date | null;
  createdAt!: Date;

  constructor(data: Partial<RegistrationChallenge>) {
    Object.assign(this, data);
  }

  isUsable(now: Date): boolean {
    return (
      this.codeHash !== null &&
      this.expiresAt !== null &&
      this.consumedAt === null &&
      this.invalidatedAt === null &&
      !isPast(this.expiresAt, now)
    );
  }
}
