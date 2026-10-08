import type { Knex } from "knex";
import { User } from "../../../../src/app/auth/entity/user.entity";
import { RevokedReason, UserStatus } from "../../../../src/app/auth/enums";
import type { AccountService } from "../../../../src/app/auth/service/account.service";
import type { SessionService } from "../../../../src/app/auth/service/session.service";
import type { LiveFamily, UserListItem } from "../../../../src/app/auth/types";
import { StatusCaller } from "../../../../src/app/users/enums";
import { UsersService } from "../../../../src/app/users/service/users.service";
import type { StatusChangeCommand } from "../../../../src/app/users/types";
import { decodeCursor, decodeKeyCursor } from "../../../../src/lib/http/pagination/cursor";
import { Logger } from "../../../../src/lib/logger/logger";
import type { MockedModule } from "../../../helpers/types";

jest.mock("../../../../src/app/users/repository/user-status-change.repo", () => ({
  insertStatusChange: jest.fn(),
}));

const statusChanges = jest.requireMock<
  MockedModule<typeof import("../../../../src/app/users/repository/user-status-change.repo")>
>("../../../../src/app/users/repository/user-status-change.repo");

const NOW = new Date("2026-10-07T10:00:00.000Z");
const LATER = new Date("2026-10-07T10:05:00.000Z");
const REQUEST_ID = "7f1c0000-0000-4000-8000-0000000000aa";
const REASON = "synthetic-reason-with-private-detail";
const ADMIN_ID = 1;
const TARGET_ID = 42;

function user(overrides: Partial<User> = {}): User {
  return new User({
    id: TARGET_ID,
    email: "amira.patient@example.test",
    phone: "+201000000001",
    passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA",
    fullName: "Amira Hassan",
    avatarUrl: null,
    role: "patient",
    status: "active",
    emailVerifiedAt: NOW,
    timezone: "Africa/Cairo",
    locale: "ar-EG",
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null,
    ...overrides,
  });
}

function command(overrides: Partial<StatusChangeCommand> = {}): StatusChangeCommand {
  return {
    targetId: TARGET_ID,
    toStatus: UserStatus.Suspended,
    reason: REASON,
    caller: { kind: StatusCaller.Admin, actorUserId: ADMIN_ID },
    requestId: REQUEST_ID,
    ...overrides,
  };
}

function logSink(): { logger: Logger; lines: () => Record<string, unknown>[]; text: () => string } {
  const written: string[] = [];
  return {
    logger: new Logger({
      service: "identity-service",
      level: "debug",
      production: false,
      sink: (line) => {
        written.push(line);
      },
    }),
    lines: () =>
      written
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
    text: () => written.join(""),
  };
}

let events: string[];
let trx: { commit: jest.Mock; rollback: jest.Mock };
let dbMock: { transaction: jest.Mock };
let accounts: {
  findLiveById: jest.Mock;
  listLive: jest.Mock;
  lockLiveById: jest.Mock;
  updateStatus: jest.Mock;
  existsIncludingDeleted: jest.Mock;
};
let sessions: { listLiveFamilies: jest.Mock; revokeAllForUser: jest.Mock };
let sink: ReturnType<typeof logSink>;
let service: UsersService;

function track<T>(name: string, value: T): jest.Mock {
  return jest.fn().mockImplementation(() => {
    events.push(name);
    return Promise.resolve(value);
  });
}

beforeEach(() => {
  events = [];
  sink = logSink();
  trx = {
    commit: track("commit", undefined),
    rollback: track("rollback", undefined),
  };
  dbMock = { transaction: jest.fn().mockImplementation(() => {
    events.push("begin");
    return Promise.resolve(trx);
  }) };
  accounts = {
    findLiveById: jest.fn().mockImplementation((id: number) => {
      events.push(`read:${String(id)}`);
      return Promise.resolve(user({ id, role: "admin", status: "active" }));
    }),
    listLive: jest.fn(),
    lockLiveById: jest.fn().mockImplementation(() => {
      events.push("lock");
      return Promise.resolve(user());
    }),
    existsIncludingDeleted: jest.fn().mockImplementation(() => {
      events.push("actor");
      return Promise.resolve(true);
    }),
    updateStatus: jest.fn().mockImplementation((_trx: unknown, _id: number, status: string) => {
      events.push("update");
      return Promise.resolve(user({ status: status as User["status"], updatedAt: LATER }));
    }),
  };
  sessions = {
    listLiveFamilies: jest.fn(),
    revokeAllForUser: jest.fn().mockImplementation(() => {
      events.push("revoke");
      return Promise.resolve(3);
    }),
  };
  statusChanges.insertStatusChange.mockImplementation(() => {
    events.push("history");
    return Promise.resolve(1);
  });

  service = new UsersService(
    dbMock as unknown as Knex,
    sink.logger,
    accounts as unknown as AccountService,
    sessions as unknown as SessionService,
  );
});

describe("UsersService.getUser", () => {
  it("should return the user when the id is live", async () => {
    accounts.findLiveById.mockResolvedValue(user());

    await expect(service.getUser(TARGET_ID)).resolves.toMatchObject({ id: TARGET_ID });
  });

  it("should throw NotFound when the id is absent or soft-deleted", async () => {
    accounts.findLiveById.mockResolvedValue(undefined);

    await expect(service.getUser(TARGET_ID)).rejects.toMatchObject({ code: "NotFound", status: 404 });
  });
});

describe("UsersService.listUsers", () => {
  function item(id: number, microseconds: string): UserListItem {
    return { user: user({ id }), createdAtCursor: `2026-10-07T10:00:00.${microseconds}Z` };
  }

  it("should return a page whose cursor carries the last row's microsecond text and id when more rows exist", async () => {
    accounts.listLive.mockResolvedValue([item(3, "000003"), item(2, "000002"), item(1, "000001")]);

    const page = await service.listUsers({}, undefined, 2);

    expect(page.items.map((row) => row.user.id)).toEqual([3, 2]);
    expect(page.meta).toMatchObject({ hasMore: true, count: 2 });
    expect(decodeCursor(page.meta.nextCursor ?? "", "iso-timestamp")).toEqual({
      v: "2026-10-07T10:00:00.000002Z",
      id: 2,
    });
  });

  it("should return no cursor when the rows do not exceed the limit", async () => {
    accounts.listLive.mockResolvedValue([item(2, "000002"), item(1, "000001")]);

    const page = await service.listUsers({ role: "patient" }, undefined, 2);

    expect(page.meta).toEqual({ nextCursor: null, hasMore: false, count: 2 });
    expect(accounts.listLive).toHaveBeenCalledWith({ role: "patient" }, undefined, 2);
  });
});

describe("UsersService.listSessions", () => {
  const family = (familyId: string, microseconds: string): LiveFamily => ({
    familyId,
    deviceInfo: null,
    createdAt: NOW,
    createdAtCursor: `2026-10-07T10:00:00.${microseconds}Z`,
    lastUsedAt: NOW,
    expiresAt: LATER,
  });

  it("should throw NotFound without listing when the target is absent", async () => {
    accounts.findLiveById.mockResolvedValue(undefined);

    await expect(service.listSessions(TARGET_ID, undefined, 20)).rejects.toMatchObject({ code: "NotFound" });
    expect(sessions.listLiveFamilies).not.toHaveBeenCalled();
  });

  it("should return an empty page, not an error, when the target has no live families", async () => {
    accounts.findLiveById.mockResolvedValue(user({ status: "suspended" }));
    sessions.listLiveFamilies.mockResolvedValue([]);

    const page = await service.listSessions(TARGET_ID, undefined, 20);

    expect(page.items).toEqual([]);
    expect(page.meta).toEqual({ nextCursor: null, hasMore: false, count: 0 });
  });

  it("should build a key cursor from the family id and its microsecond text when more rows exist", async () => {
    const a = "8f1c4e2a-0000-4000-8000-00000000000a";
    const b = "8f1c4e2a-0000-4000-8000-00000000000b";
    accounts.findLiveById.mockResolvedValue(user());
    sessions.listLiveFamilies.mockResolvedValue([family(a, "000009"), family(b, "000009")]);

    const page = await service.listSessions(TARGET_ID, undefined, 1);

    expect(page.items).toHaveLength(1);
    expect(decodeKeyCursor(page.meta.nextCursor ?? "")).toEqual({ v: "2026-10-07T10:00:00.000009Z", k: a });
  });
});

describe("UsersService.revokeSessions", () => {
  it("should re-read the live actor before opening the transaction", async () => {
    await service.revokeSessions(ADMIN_ID, TARGET_ID);

    expect(events.slice(0, 2)).toEqual([`read:${String(ADMIN_ID)}`, "begin"]);
  });

  it("should throw Unauthorized and open no transaction when the acting admin no longer exists", async () => {
    accounts.findLiveById.mockResolvedValue(undefined);

    await expect(service.revokeSessions(ADMIN_ID, TARGET_ID)).rejects.toMatchObject({
      code: "Unauthorized",
      status: 401,
    });
    expect(dbMock.transaction).not.toHaveBeenCalled();
  });

  it("should throw AccountSuspended and open no transaction when the acting admin was suspended since the token was issued", async () => {
    accounts.findLiveById.mockResolvedValue(user({ id: ADMIN_ID, role: "admin", status: "suspended" }));

    await expect(service.revokeSessions(ADMIN_ID, TARGET_ID)).rejects.toMatchObject({
      code: "AccountSuspended",
      status: 403,
    });
    expect(dbMock.transaction).not.toHaveBeenCalled();
    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
  });

  it("should lock the target before revoking, with reason admin_revoked on the same transaction, then commit", async () => {
    await service.revokeSessions(ADMIN_ID, TARGET_ID);

    expect(events).toEqual([`read:${String(ADMIN_ID)}`, "begin", "lock", "revoke", "commit"]);
    expect(accounts.lockLiveById).toHaveBeenCalledWith(trx, TARGET_ID);
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(trx, TARGET_ID, RevokedReason.AdminRevoked);
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({
        message: "admin_sessions_revoked",
        actorUserId: ADMIN_ID,
        userId: TARGET_ID,
        revokedSessions: 3,
      }),
    );
  });

  it("should roll back and throw NotFound when the target vanished before the lock", async () => {
    accounts.lockLiveById.mockResolvedValue(undefined);

    await expect(service.revokeSessions(ADMIN_ID, TARGET_ID)).rejects.toMatchObject({ code: "NotFound" });

    expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    expect(trx.commit).not.toHaveBeenCalled();
    expect(trx.rollback).toHaveBeenCalledTimes(1);
  });

  it("should allow the caller to revoke its own sessions", async () => {
    accounts.lockLiveById.mockResolvedValue(user({ id: ADMIN_ID, role: "admin" }));

    await expect(service.revokeSessions(ADMIN_ID, ADMIN_ID)).resolves.toBeUndefined();
    expect(sessions.revokeAllForUser).toHaveBeenCalledWith(trx, ADMIN_ID, RevokedReason.AdminRevoked);
  });

  it("should roll back and rethrow when the revocation fails, without logging success", async () => {
    sessions.revokeAllForUser.mockRejectedValue(new Error("connection lost"));

    await expect(service.revokeSessions(ADMIN_ID, TARGET_ID)).rejects.toThrow("connection lost");

    expect(trx.commit).not.toHaveBeenCalled();
    expect(trx.rollback).toHaveBeenCalledTimes(1);
    expect(sink.lines().map((line) => line.message)).not.toContain("admin_sessions_revoked");
  });
});

describe("UsersService.applyStatusChange", () => {
  describe("D-5 live-actor re-read", () => {
    it("should throw Unauthorized before any transaction when the acting admin no longer exists", async () => {
      accounts.findLiveById.mockResolvedValue(undefined);

      await expect(service.applyStatusChange(command())).rejects.toMatchObject({ code: "Unauthorized" });
      expect(dbMock.transaction).not.toHaveBeenCalled();
    });

    it("should throw AccountSuspended before any transaction when the acting admin is suspended", async () => {
      accounts.findLiveById.mockResolvedValue(user({ id: ADMIN_ID, role: "admin", status: "suspended" }));

      await expect(service.applyStatusChange(command())).rejects.toMatchObject({ code: "AccountSuspended" });
      expect(dbMock.transaction).not.toHaveBeenCalled();
      expect(accounts.lockLiveById).not.toHaveBeenCalled();
    });
  });

  describe("service caller (Cases 1, 3 and 4)", () => {
    const serviceCaller = {
      kind: StatusCaller.Service,
      actorService: "care-service",
      actorUserId: 9,
    } as const;

    it("should skip the live-actor re-read and the admin target rules, and record actor_service with the body actor id", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "suspended" }));

      const result = await service.applyStatusChange(
        command({ toStatus: UserStatus.Active, caller: serviceCaller }),
      );

      expect(accounts.findLiveById).not.toHaveBeenCalled();
      expect(result).toMatchObject({ id: TARGET_ID, status: "active", changed: true });
      expect(statusChanges.insertStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: TARGET_ID,
          fromStatus: "suspended",
          toStatus: "active",
          actorUserId: 9,
          actorService: "care-service",
          requestId: REQUEST_ID,
        }),
        trx,
      );
    });

    it("should reinstate suspended to active without revoking or reviving any refresh token", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "suspended" }));

      await service.applyStatusChange(command({ toStatus: UserStatus.Active, caller: serviceCaller }));

      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(events).toEqual(["begin", "update", "actor", "history", "commit"]);
    });

    it("should return 200 without writing when the doctor is already active (idempotent Case 4 retry)", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "active" }));

      const result = await service.applyStatusChange(
        command({ toStatus: UserStatus.Active, caller: serviceCaller }),
      );

      expect(result).toMatchObject({ status: "active", changed: false });
      expect(statusChanges.insertStatusChange).not.toHaveBeenCalled();
      expect(accounts.updateStatus).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(trx.rollback).toHaveBeenCalledTimes(1);
    });

    it("should re-assert revocation and write no history when Care repeats a suspension that already landed", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "suspended", updatedAt: LATER }));

      const result = await service.applyStatusChange(command({ caller: serviceCaller }));

      expect(result).toMatchObject({ status: "suspended", changed: false, updatedAt: LATER });
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(trx, TARGET_ID, RevokedReason.StatusChanged);
      expect(statusChanges.insertStatusChange).not.toHaveBeenCalled();
      expect(accounts.updateStatus).not.toHaveBeenCalled();
      expect(trx.commit).toHaveBeenCalledTimes(1);
    });

    it.each([
      ["pending", "suspended"],
      ["rejected", "active"],
      ["active", "rejected"],
      ["active", "pending"],
      ["suspended", "pending"],
    ])("should throw InvalidStatusTransition and write nothing for %s to %s", async (from, to) => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: from as User["status"] }));

      await expect(
        service.applyStatusChange(command({ toStatus: to as UserStatus, caller: serviceCaller })),
      ).rejects.toMatchObject({ code: "InvalidStatusTransition" });

      expect(accounts.updateStatus).not.toHaveBeenCalled();
      expect(statusChanges.insertStatusChange).not.toHaveBeenCalled();
      expect(trx.rollback).toHaveBeenCalled();
    });

    it("should revoke every refresh family when Care rejects a pending doctor", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "pending" }));

      await service.applyStatusChange(command({ toStatus: UserStatus.Rejected, caller: serviceCaller }));

      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(trx, TARGET_ID, RevokedReason.StatusChanged);
    });

    it("should not revoke when Care re-opens a rejected application", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "rejected" }));

      await service.applyStatusChange(command({ toStatus: UserStatus.Pending, caller: serviceCaller }));

      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    });

    it("should store a NULL actor and still succeed when the body actor id does not exist", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "suspended" }));
      accounts.existsIncludingDeleted.mockResolvedValue(false);

      const result = await service.applyStatusChange(
        command({ toStatus: UserStatus.Active, caller: serviceCaller }),
      );

      expect(result.changed).toBe(true);
      expect(statusChanges.insertStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({ actorUserId: null, actorService: "care-service" }),
        trx,
      );
      expect(sink.lines().map((line) => line.message)).toContain("status_change_actor_unknown");
    });

    it("should return NotFound when the target does not exist", async () => {
      accounts.lockLiveById.mockResolvedValue(undefined);

      await expect(
        service.applyStatusChange(command({ toStatus: UserStatus.Active, caller: serviceCaller })),
      ).rejects.toMatchObject({ code: "NotFound" });
    });

    it.each(["patient", "admin"] as const)(
      "should throw Forbidden and write nothing when the service caller targets a %s (BR-19, ADR 0025)",
      async (role) => {
        accounts.lockLiveById.mockResolvedValue(user({ role, status: "active" }));

        for (const toStatus of Object.values(UserStatus)) {
          await expect(
            service.applyStatusChange(command({ toStatus, caller: serviceCaller })),
          ).rejects.toMatchObject({ code: "Forbidden", status: 403 });
        }

        expect(accounts.updateStatus).not.toHaveBeenCalled();
        expect(accounts.existsIncludingDeleted).not.toHaveBeenCalled();
        expect(statusChanges.insertStatusChange).not.toHaveBeenCalled();
        expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
        expect(trx.commit).not.toHaveBeenCalled();
        expect(trx.rollback).toHaveBeenCalled();
      },
    );

    it("should refuse a non-doctor even when the requested status equals the current one, and log only ids and the cause", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "patient", status: "suspended" }));

      await expect(service.applyStatusChange(command({ caller: serviceCaller }))).rejects.toMatchObject({
        code: "Forbidden",
      });

      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      const refused = sink.lines().find((line) => line.message === "status_change_refused");
      expect(refused).toMatchObject({ cause: "role", userId: TARGET_ID, actorService: "care-service" });
      expect(sink.text()).not.toContain(REASON);
      expect(sink.text()).not.toContain("amira.patient@example.test");
    });

    it("should roll back without committing when the history insert fails for a service caller", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "active" }));
      statusChanges.insertStatusChange.mockRejectedValue(new Error("connection lost"));

      await expect(service.applyStatusChange(command({ caller: serviceCaller }))).rejects.toThrow("connection lost");

      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(trx.commit).not.toHaveBeenCalled();
      expect(trx.rollback).toHaveBeenCalledTimes(1);
      expect(sink.lines().map((line) => line.message)).not.toContain("user_status_changed");
    });

    it("should roll back without committing or logging success when the revocation fails for a service caller", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "active" }));
      sessions.revokeAllForUser.mockRejectedValue(new Error("connection lost"));

      await expect(service.applyStatusChange(command({ caller: serviceCaller }))).rejects.toThrow("connection lost");

      expect(trx.commit).not.toHaveBeenCalled();
      expect(trx.rollback).toHaveBeenCalledTimes(1);
      expect(sink.lines().map((line) => line.message)).not.toContain("user_status_changed");
    });

    it("should not revoke when Care repeats a rejection that already landed", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "rejected" }));

      const result = await service.applyStatusChange(command({ toStatus: UserStatus.Rejected, caller: serviceCaller }));

      expect(result.changed).toBe(false);
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
    });

    it("should log the service and ids but never the reason or any personal data", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "suspended" }));

      await service.applyStatusChange(command({ toStatus: UserStatus.Active, caller: serviceCaller }));

      const changed = sink.lines().find((line) => line.message === "user_status_changed");
      expect(changed).toMatchObject({ actorService: "care-service", actorUserId: 9, from: "suspended", to: "active" });
      expect(sink.text()).not.toContain(REASON);
      expect(sink.text()).not.toContain("amira.patient@example.test");
    });
  });

  describe("admin caller is unchanged by the service branch", () => {
    it("should still refuse a doctor target and never reinstate one through the admin transition table", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ role: "doctor", status: "suspended" }));

      await expect(
        service.applyStatusChange(command({ toStatus: UserStatus.Active })),
      ).rejects.toMatchObject({ code: "Forbidden", message: "Doctor account status is managed by care-service" });

      expect(accounts.updateStatus).not.toHaveBeenCalled();
      expect(accounts.existsIncludingDeleted).not.toHaveBeenCalled();
    });
  });

  describe("ordering inside the transaction (ADR 0019 / 0020)", () => {
    it("should lock the target before any write, then update, write history, revoke, and commit when suspending", async () => {
      const result = await service.applyStatusChange(command());

      expect(events).toEqual([
        `read:${String(ADMIN_ID)}`,
        "begin",
        "lock",
        "update",
        "history",
        "revoke",
        "commit",
      ]);
      expect(result).toEqual({ id: TARGET_ID, status: "suspended", updatedAt: LATER, changed: true });
    });

    it("should run the lock, update, history insert and revocation on the one transaction", async () => {
      await service.applyStatusChange(command());

      expect(accounts.lockLiveById).toHaveBeenCalledWith(trx, TARGET_ID);
      expect(accounts.updateStatus).toHaveBeenCalledWith(trx, TARGET_ID, "suspended");
      expect(statusChanges.insertStatusChange).toHaveBeenCalledWith(expect.any(Object), trx);
      expect(sessions.revokeAllForUser).toHaveBeenCalledWith(trx, TARGET_ID, RevokedReason.StatusChanged);
      expect(dbMock.transaction).toHaveBeenCalledTimes(1);
    });

    it("should write the history row with actor_user_id from the caller, a null service, the reason and the request id", async () => {
      await service.applyStatusChange(command());

      expect(statusChanges.insertStatusChange).toHaveBeenCalledWith(
        {
          userId: TARGET_ID,
          fromStatus: "active",
          toStatus: "suspended",
          actorUserId: ADMIN_ID,
          actorService: null,
          reason: REASON,
          requestId: REQUEST_ID,
        },
        trx,
      );
    });

    it("should not revoke any session when reinstating a suspended patient", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ status: "suspended" }));

      const result = await service.applyStatusChange(command({ toStatus: UserStatus.Active }));

      expect(result).toMatchObject({ status: "active", changed: true });
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(statusChanges.insertStatusChange).toHaveBeenCalledWith(
        expect.objectContaining({ fromStatus: "suspended", toStatus: "active" }),
        trx,
      );
      expect(accounts.lockLiveById).toHaveBeenCalledWith(trx, TARGET_ID);
      expect(events).toEqual([`read:${String(ADMIN_ID)}`, "begin", "update", "history", "commit"]);
    });
  });

  describe("target rules run before the transition check and write nothing (BR-4)", () => {
    it.each([
      ["self", "self", { id: ADMIN_ID, role: "admin" as const }, "You cannot change your own account status"],
      ["another admin", "admin", { id: 7, role: "admin" as const }, "You cannot change another admin's account status"],
      ["a doctor", "doctor", { id: 8, role: "doctor" as const, status: "active" as const }, "Doctor account status is managed by care-service"],
    ])("should throw Forbidden and write nothing when the target is %s", async (_label, cause, target, message) => {
      accounts.lockLiveById.mockResolvedValue(user(target));

      await expect(service.applyStatusChange(command({ targetId: target.id }))).rejects.toMatchObject({
        code: "Forbidden",
        status: 403,
        message,
      });

      expect(accounts.updateStatus).not.toHaveBeenCalled();
      expect(statusChanges.insertStatusChange).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(trx.commit).not.toHaveBeenCalled();
      expect(trx.rollback).toHaveBeenCalledTimes(1);
      expect(sink.lines()).toContainEqual(
        expect.objectContaining({ message: "status_change_refused", cause }),
      );
    });

    it("should answer Forbidden, not a no-op, when the doctor already has the requested status", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ id: 8, role: "doctor", status: "suspended" }));

      await expect(
        service.applyStatusChange(command({ targetId: 8, toStatus: UserStatus.Suspended })),
      ).rejects.toMatchObject({ code: "Forbidden" });
    });

    it("should answer Forbidden for self before it considers an invalid transition", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ id: ADMIN_ID, role: "admin", status: "pending" }));

      await expect(
        service.applyStatusChange(command({ targetId: ADMIN_ID, toStatus: UserStatus.Active })),
      ).rejects.toMatchObject({ code: "Forbidden" });
    });

    it("should treat the self check as taking precedence over the admin-target check", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ id: ADMIN_ID, role: "admin" }));

      await expect(service.applyStatusChange(command({ targetId: ADMIN_ID }))).rejects.toMatchObject({
        message: "You cannot change your own account status",
      });
    });
  });

  describe("not found", () => {
    it("should roll back and throw NotFound when the target is absent or soft-deleted", async () => {
      accounts.lockLiveById.mockResolvedValue(undefined);

      await expect(service.applyStatusChange(command())).rejects.toMatchObject({ code: "NotFound", status: 404 });

      expect(accounts.updateStatus).not.toHaveBeenCalled();
      expect(trx.commit).not.toHaveBeenCalled();
      expect(trx.rollback).toHaveBeenCalledTimes(1);
    });
  });

  describe("same-status no-op (BR-6)", () => {
    it("should return changed false with the current updatedAt and write nothing when the status already matches", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ status: "suspended", updatedAt: NOW }));

      const result = await service.applyStatusChange(command({ toStatus: UserStatus.Suspended }));

      expect(result).toEqual({ id: TARGET_ID, status: "suspended", updatedAt: NOW, changed: false });
      expect(accounts.updateStatus).not.toHaveBeenCalled();
      expect(statusChanges.insertStatusChange).not.toHaveBeenCalled();
      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(trx.commit).not.toHaveBeenCalled();
      expect(trx.rollback).toHaveBeenCalledTimes(1);
      expect(sink.lines().map((line) => line.message)).not.toContain("user_status_changed");
    });
  });

  describe("transition table (BR-5)", () => {
    it.each(["pending", "rejected"] as const)(
      "should throw InvalidStatusTransition and write nothing when a %s patient is asked to change status",
      async (status) => {
        for (const toStatus of [UserStatus.Active, UserStatus.Suspended]) {
          accounts.lockLiveById.mockResolvedValue(user({ status }));
          await expect(service.applyStatusChange(command({ toStatus }))).rejects.toMatchObject({
            code: "InvalidStatusTransition",
            status: 409,
          });
        }

        expect(accounts.updateStatus).not.toHaveBeenCalled();
        expect(statusChanges.insertStatusChange).not.toHaveBeenCalled();
        expect(trx.commit).not.toHaveBeenCalled();
      },
    );

    it("should log the refusal cause as transition without echoing statuses or the reason", async () => {
      accounts.lockLiveById.mockResolvedValue(user({ status: "pending" }));

      await expect(service.applyStatusChange(command())).rejects.toMatchObject({ code: "InvalidStatusTransition" });

      expect(sink.lines()).toContainEqual(
        expect.objectContaining({ message: "status_change_refused", cause: "transition", userId: TARGET_ID }),
      );
      expect(sink.text()).not.toContain(REASON);
    });
  });

  describe("failure inside the transaction rolls everything back (BR-7)", () => {
    it("should roll back and throw when the update affects no row, never committing", async () => {
      accounts.updateStatus.mockResolvedValue(undefined);

      await expect(service.applyStatusChange(command())).rejects.toThrow("user_status_update_affected_no_row");

      expect(statusChanges.insertStatusChange).not.toHaveBeenCalled();
      expect(trx.commit).not.toHaveBeenCalled();
      expect(trx.rollback).toHaveBeenCalledTimes(1);
    });

    it("should roll back without revoking when the history insert fails", async () => {
      statusChanges.insertStatusChange.mockRejectedValue(new Error("constraint violated"));

      await expect(service.applyStatusChange(command())).rejects.toThrow("constraint violated");

      expect(sessions.revokeAllForUser).not.toHaveBeenCalled();
      expect(trx.commit).not.toHaveBeenCalled();
      expect(trx.rollback).toHaveBeenCalledTimes(1);
    });

    it("should roll back and never commit when the revocation fails", async () => {
      sessions.revokeAllForUser.mockRejectedValue(new Error("connection lost"));

      await expect(service.applyStatusChange(command())).rejects.toThrow("connection lost");

      expect(trx.commit).not.toHaveBeenCalled();
      expect(trx.rollback).toHaveBeenCalledTimes(1);
      expect(sink.lines().map((line) => line.message)).not.toContain("user_status_changed");
    });

    it("should roll back and rethrow when the commit itself fails, and log no success", async () => {
      trx.commit.mockRejectedValue(new Error("commit failed"));

      await expect(service.applyStatusChange(command())).rejects.toThrow("commit failed");

      expect(trx.rollback).toHaveBeenCalledTimes(1);
      expect(sink.lines().map((line) => line.message)).not.toContain("user_status_changed");
    });

    it("should propagate the original error when the rollback also fails", async () => {
      statusChanges.insertStatusChange.mockRejectedValue(new Error("constraint violated"));
      trx.rollback.mockRejectedValue(new Error("rollback failed"));

      await expect(service.applyStatusChange(command())).rejects.toThrow("constraint violated");
    });
  });

  describe("logging", () => {
    it("should log user_status_changed with ids and statuses only, never the reason or personal data", async () => {
      await service.applyStatusChange(command());

      expect(sink.lines()).toContainEqual(
        expect.objectContaining({
          message: "user_status_changed",
          actorUserId: ADMIN_ID,
          userId: TARGET_ID,
          from: "active",
          to: "suspended",
          revokedSessions: 3,
        }),
      );
      expect(sink.text()).not.toContain(REASON);
      expect(sink.text()).not.toContain("amira.patient@example.test");
      expect(sink.text()).not.toContain("Amira Hassan");
      expect(sink.text()).not.toContain("$argon2");
    });
  });
});
