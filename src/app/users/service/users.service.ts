import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { AccountSuspended, NotFound, Unauthorized } from "../../../lib/error/errors";
import { buildKeyPage, buildPage } from "../../../lib/http/pagination/page";
import type { Page } from "../../../lib/http/pagination/types";
import type { Logger } from "../../../lib/logger/logger";
import type { User } from "../../auth/entity/user.entity";
import { RevokedReason, UserStatus } from "../../auth/enums";
import type { AccountService } from "../../auth/service/account.service";
import type { SessionService } from "../../auth/service/session.service";
import type {
  LiveFamily,
  LiveFamilyCursor,
  UserListCursor,
  UserListFilter,
  UserListItem,
} from "../../auth/types";
import { StatusCaller } from "../enums";
import { InvalidStatusTransition, TargetIsAdmin, TargetIsDoctor, TargetIsSelf } from "../errors";
import * as statusChanges from "../repository/user-status-change.repo";
import { ADMIN_TRANSITIONS } from "../status-transitions";
import type { StatusChangeCommand, StatusChangeResult, TargetRefusal } from "../types";

/**
 * Admin account management (CLAUDE.md -> Domain rules 3, 4, 6) and the shared status-transition method
 * Epic B's internal route reuses (spec D-1).
 *
 * Lock order (ADR 0019 / 0020): every mutation locks the `users` row `FOR UPDATE` first, then writes the
 * status, the history row and the token revocations, all in one transaction.
 */
@injectable()
export class UsersService {
  constructor(
    @inject(TOKENS.Db) private readonly db: Knex,
    @inject(TOKENS.Logger) private readonly logger: Logger,
    @inject(TOKENS.AccountService) private readonly accounts: AccountService,
    @inject(TOKENS.SessionService) private readonly sessions: SessionService,
  ) {}

  async getUser(id: number): Promise<User> {
    const user = await this.accounts.findLiveById(id);
    if (user === undefined) {
      throw NotFound;
    }
    return user;
  }

  async listUsers(
    filter: UserListFilter,
    cursor: UserListCursor | undefined,
    limit: number,
  ): Promise<Page<UserListItem>> {
    const rows = await this.accounts.listLive(filter, cursor, limit);
    return buildPage(rows, limit, (row) => ({ v: row.createdAtCursor, id: row.user.id }));
  }

  /** A suspended target simply has no live families: an empty page, not an error. */
  async listSessions(
    userId: number,
    cursor: LiveFamilyCursor | undefined,
    limit: number,
  ): Promise<Page<LiveFamily>> {
    const target = await this.accounts.findLiveById(userId);
    if (target === undefined) {
      throw NotFound;
    }
    const rows = await this.sessions.listLiveFamilies(userId, cursor, limit);
    return buildKeyPage(rows, limit, (row) => ({ v: row.createdAtCursor, k: row.familyId }));
  }

  /** Idempotent: a user without live sessions is still a success. Any existing target is allowed. */
  async revokeSessions(actorUserId: number, targetId: number): Promise<void> {
    await this.requireLiveActor(actorUserId);

    const trx = await this.db.transaction();
    let revokedSessions: number;
    try {
      const target = await this.accounts.lockLiveById(trx, targetId);
      if (target === undefined) {
        throw NotFound;
      }
      revokedSessions = await this.sessions.revokeAllForUser(trx, targetId, RevokedReason.AdminRevoked);
      await trx.commit();
    } catch (err) {
      await trx.rollback().catch(() => undefined);
      throw err;
    }

    this.logger.info("admin_sessions_revoked", { actorUserId, userId: targetId, revokedSessions });
  }

  /**
   * Admin caller only (spec D-1). Evaluation order: live-actor re-read, lock the target (404), target rules
   * (403), same status (200 no-op), transition table (409), then write. One transaction.
   */
  async applyStatusChange(command: StatusChangeCommand): Promise<StatusChangeResult> {
    const { caller } = command;
    if (caller.kind !== StatusCaller.Admin) {
      // Wired by `internal-users` (Epic B) with its own transition table and target rules.
      throw new Error("status_change_caller_not_supported");
    }
    await this.requireLiveActor(caller.actorUserId);

    const trx = await this.db.transaction();
    let result: StatusChangeResult;
    let revokedSessions = 0;
    let fromStatus: UserStatus | undefined;
    try {
      const target = await this.accounts.lockLiveById(trx, command.targetId);
      if (target === undefined) {
        throw NotFound;
      }

      const refusal = this.targetRefusal(target, caller.actorUserId);
      if (refusal !== undefined) {
        this.logger.warn("status_change_refused", {
          actorUserId: caller.actorUserId,
          userId: target.id,
          cause: refusal.cause,
        });
        throw refusal.error;
      }

      const current = target.status as UserStatus;
      if (current === command.toStatus) {
        await trx.rollback();
        return { id: target.id, status: current, updatedAt: target.updatedAt, changed: false };
      }

      if (!ADMIN_TRANSITIONS[current].includes(command.toStatus)) {
        this.logger.warn("status_change_refused", {
          actorUserId: caller.actorUserId,
          userId: target.id,
          cause: "transition",
        });
        throw InvalidStatusTransition;
      }

      const updated = await this.accounts.updateStatus(trx, target.id, command.toStatus);
      if (updated === undefined) {
        // Impossible under the row lock, but never ignored: the transaction rolls back and the request is a 500.
        throw new Error("user_status_update_affected_no_row");
      }

      await statusChanges.insertStatusChange(
        {
          userId: target.id,
          fromStatus: current,
          toStatus: command.toStatus,
          actorUserId: caller.actorUserId,
          actorService: null,
          reason: command.reason,
          requestId: command.requestId,
        },
        trx,
      );

      if (command.toStatus === UserStatus.Suspended) {
        revokedSessions = await this.sessions.revokeAllForUser(trx, target.id, RevokedReason.StatusChanged);
      }

      await trx.commit();
      fromStatus = current;
      result = { id: updated.id, status: command.toStatus, updatedAt: updated.updatedAt, changed: true };
    } catch (err) {
      await trx.rollback().catch(() => undefined);
      throw err;
    }

    // Ids and statuses only: the free-text reason is never logged.
    this.logger.info("user_status_changed", {
      actorUserId: caller.actorUserId,
      userId: result.id,
      from: fromStatus,
      to: command.toStatus,
      revokedSessions,
    });
    return result;
  }

  /** The policy checks only the token claim (<= 15 min stale); mutations re-read the live actor row (D-5). */
  private async requireLiveActor(actorUserId: number): Promise<void> {
    const actor = await this.accounts.findLiveById(actorUserId);
    if (actor === undefined) {
      throw Unauthorized;
    }
    if (actor.isSuspended()) {
      throw AccountSuspended;
    }
  }

  /** Domain rule 6 / ADR 0012: patients only, never self. Checked before anything is written. */
  private targetRefusal(target: User, actorUserId: number): TargetRefusal | undefined {
    if (target.id === actorUserId) {
      return { error: TargetIsSelf, cause: "self" };
    }
    if (target.role === "admin") {
      return { error: TargetIsAdmin, cause: "admin" };
    }
    if (target.role === "doctor") {
      return { error: TargetIsDoctor, cause: "doctor" };
    }
    return undefined;
  }
}
