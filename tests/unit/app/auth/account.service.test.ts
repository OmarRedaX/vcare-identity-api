import { User } from "../../../../src/app/auth/entity/user.entity";
import { AccountService } from "../../../../src/app/auth/service/account.service";
import { Logger } from "../../../../src/lib/logger/logger";
import type { MockedModule } from "../../../helpers/types";

jest.mock("../../../../src/app/auth/repository/user.repo", () => ({
  findLiveById: jest.fn(),
  updateProfileUnlessSuspended: jest.fn(),
}));

const users = jest.requireMock("../../../../src/app/auth/repository/user.repo") as MockedModule<
  typeof import("../../../../src/app/auth/repository/user.repo")
>;

const NOW = new Date("2026-09-18T10:00:00.000Z");
const EMAIL = "amira.patient@example.test";

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

function user(overrides: Partial<User> = {}): User {
  return new User({
    id: 1042,
    email: EMAIL,
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

let sink: ReturnType<typeof logSink>;
let service: AccountService;

beforeEach(() => {
  sink = logSink();
  service = new AccountService(sink.logger);
});

describe("AccountService.getMe", () => {
  it("should return the live row for a pending, active or rejected account", async () => {
    for (const status of ["pending", "active", "rejected"] as const) {
      users.findLiveById.mockResolvedValue(user({ status }));

      await expect(service.getMe(1042)).resolves.toMatchObject({ id: 1042, status });
    }
  });

  it("should throw AccountSuspended when the live row is suspended", async () => {
    users.findLiveById.mockResolvedValue(user({ status: "suspended" }));

    await expect(service.getMe(1042)).rejects.toMatchObject({
      code: "AccountSuspended",
      status: 403,
    });
  });

  it("should throw Unauthorized when the subject was soft-deleted or never existed", async () => {
    users.findLiveById.mockResolvedValue(undefined);

    await expect(service.getMe(1042)).rejects.toMatchObject({ code: "Unauthorized", status: 401 });
  });
});

describe("AccountService.updateMe", () => {
  it("should return the updated row and log only the field names when the patch applies", async () => {
    users.updateProfileUnlessSuspended.mockResolvedValue(user({ fullName: "Amira H." }));

    await expect(service.updateMe(1042, { fullName: "Amira H.", phone: null })).resolves.toMatchObject({
      fullName: "Amira H.",
    });

    expect(users.updateProfileUnlessSuspended).toHaveBeenCalledWith(1042, {
      fullName: "Amira H.",
      phone: null,
    });
    expect(sink.lines()).toContainEqual(
      expect.objectContaining({ message: "profile_updated", userId: 1042, fields: ["fullName", "phone"] }),
    );
    expect(sink.text()).not.toContain("Amira H.");
  });

  it("should throw AccountSuspended when no row was updated but the account still exists", async () => {
    users.updateProfileUnlessSuspended.mockResolvedValue(undefined);
    users.findLiveById.mockResolvedValue(user({ status: "suspended" }));

    await expect(service.updateMe(1042, { fullName: "Amira H." })).rejects.toMatchObject({
      code: "AccountSuspended",
    });
  });

  it("should throw Unauthorized when no row was updated and the account is gone", async () => {
    users.updateProfileUnlessSuspended.mockResolvedValue(undefined);
    users.findLiveById.mockResolvedValue(undefined);

    await expect(service.updateMe(1042, { fullName: "Amira H." })).rejects.toMatchObject({
      code: "Unauthorized",
    });
  });

  it("should propagate an infrastructure failure when the database is unreachable", async () => {
    users.updateProfileUnlessSuspended.mockRejectedValue(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
    );

    await expect(service.updateMe(1042, { fullName: "Amira H." })).rejects.toThrow("ECONNREFUSED");
  });
});

describe("AccountService.findLiveById", () => {
  it("should pass the caller's connection through when one is given", async () => {
    users.findLiveById.mockResolvedValue(user());
    const conn = {} as never;

    await service.findLiveById(1042, conn);

    expect(users.findLiveById).toHaveBeenCalledWith(1042, conn);
  });
});
