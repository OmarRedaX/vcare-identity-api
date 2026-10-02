import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { AccountSuspended, Unauthorized } from "../../../lib/error/errors";
import type { Logger } from "../../../lib/logger/logger";
import type { User } from "../entity/user.entity";
import * as users from "../repository/user.repo";
import type { UpdateProfileInput } from "../types";

/**
 * The caller's own account, and the only way other modules reach the `users` table (spec §1.4).
 * Self routes re-read the row, so a suspended account is refused even while its access token is still
 * valid, and a soft-deleted subject becomes `401 Unauthorized` (BR-24).
 */
@injectable()
export class AccountService {
  constructor(@inject(TOKENS.Logger) private readonly logger: Logger) {}

  async getMe(userId: number): Promise<User> {
    const user = await users.findLiveById(userId);
    if (user === undefined) {
      throw Unauthorized;
    }
    if (user.isSuspended()) {
      throw AccountSuspended;
    }
    return user;
  }

  async updateMe(userId: number, patch: UpdateProfileInput): Promise<User> {
    const updated = await users.updateProfileUnlessSuspended(userId, patch);
    if (updated !== undefined) {
      // Field names only — never the submitted values (CLAUDE.md -> Privacy and logging).
      this.logger.info("profile_updated", { userId, fields: Object.keys(patch) });
      return updated;
    }

    // No row updated: tell "suspended" from "gone" with one extra read, on the failure path only.
    const existing = await users.findLiveById(userId);
    if (existing === undefined) {
      throw Unauthorized;
    }
    throw AccountSuspended;
  }

  /** For the `users` module and Epic B; they pass their own transaction when they have one. */
  findLiveById(userId: number, conn?: Knex): Promise<User | undefined> {
    return users.findLiveById(userId, conn);
  }
}
