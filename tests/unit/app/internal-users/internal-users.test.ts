import type { Request, Response } from "express";
import type { AccountService } from "../../../../src/app/auth/service/account.service";
import type { UserContact, UserSummary } from "../../../../src/app/auth/types";
import { InternalUsersController } from "../../../../src/app/internal-users/controller/internal-users.controller";
import { InternalStatusChangeDto } from "../../../../src/app/internal-users/dto/internal-users.request.dto";
import {
  UserContactResponseDto,
  UserSummaryResponseDto,
} from "../../../../src/app/internal-users/dto/internal-users.response.dto";
import {
  internalBatchPolicy,
  internalContactsPolicy,
  internalStatusPolicy,
} from "../../../../src/app/internal-users/policies";
import { InternalUsersService } from "../../../../src/app/internal-users/service/internal-users.service";
import { StatusCaller } from "../../../../src/app/users/enums";
import type { UsersService } from "../../../../src/app/users/service/users.service";
import { AppError } from "../../../../src/lib/error/AppError";
import { Logger } from "../../../../src/lib/logger/logger";
import type { ServiceAuth, UserAuth } from "../../../../src/lib/types/types";
import { validateBody } from "../../../../src/lib/validation/validate";

const REQUEST_ID = "7f1c0000-0000-4000-8000-0000000000aa";
const SERVICE: ServiceAuth = { kind: "service", clientId: "care-service", scopes: ["users:contact:read"] };

function contact(id: number): UserContact {
  return { id, email: `person${String(id)}@example.test`, fullName: "Amira Hassan", locale: "ar-EG", status: "active" };
}

async function messageOf(run: () => Promise<unknown>): Promise<AppError> {
  try {
    await run();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    return err as AppError;
  }
  throw new Error("expected a rejection");
}

/** The `ids` query rules, exercised through the controller so they hold whatever the DTO class is called. */
describe("GET /internal/users/contacts ids validation", () => {
  const entries = (count: number): string => Array.from({ length: count }, (_v, index) => String(index + 1)).join(",");

  function call(query: Record<string, unknown>): { run: () => Promise<void>; contacts: jest.Mock } {
    const contacts = jest.fn().mockResolvedValue([]);
    const controller = new InternalUsersController(
      {} as UsersService,
      { getContacts: contacts } as unknown as InternalUsersService,
    );
    const res = { locals: {}, status: () => res, json: () => res, req: { baseUrl: "/internal/users", route: { path: "/contacts" } } };
    const req = { requestId: REQUEST_ID, params: {}, query, body: {}, auth: SERVICE } as unknown as Request;
    return { run: () => controller.getContacts(req, res as unknown as Response), contacts };
  }

  it("should parse comma-separated canonical ids into integers in the order sent", async () => {
    const { run, contacts } = call({ ids: "3,1,2" });

    await run();

    expect(contacts).toHaveBeenCalledWith([3, 1, 2], "care-service");
  });

  it.each(["", "1,,2", "1,", "0", "-4", "1.5", "abc", "01", "9007199254740993", " 1"])(
    "should reject ids=%p with ValidationFailed on field ids and never query",
    async (ids) => {
      const { run, contacts } = call({ ids });

      const error = await messageOf(run);

      expect(error.code).toBe("ValidationFailed");
      expect(error.details.some((detail) => detail.field === "ids")).toBe(true);
      expect(contacts).not.toHaveBeenCalled();
    },
  );

  it("should accept 100 entries and reject 101", async () => {
    await expect(call({ ids: entries(100) }).run()).resolves.toBeUndefined();
    await expect(call({ ids: entries(101) }).run()).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("should reject a missing ids, a repeated ids key and an unknown parameter", async () => {
    await expect(call({}).run()).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(call({ ids: ["1", "2"] }).run()).rejects.toMatchObject({ code: "ValidationFailed" });
    const error = await messageOf(call({ ids: "1", email: "a@example.test" }).run);
    expect(error.details.find((detail) => detail.field === "email")?.issue).toBe("is not allowed");
  });

  it("should reject an oversized value without splitting it", async () => {
    await expect(call({ ids: "1,".repeat(5000) }).run()).rejects.toMatchObject({ code: "ValidationFailed" });
  });
});

describe("InternalStatusChangeDto", () => {
  const valid = { status: "active", reason: "Synthetic reason", actorUserId: 7 };

  it("should accept the four contract statuses", async () => {
    for (const status of ["active", "rejected", "pending", "suspended"]) {
      await expect(validateBody(InternalStatusChangeDto, { ...valid, status })).resolves.toMatchObject({ status });
    }
  });

  it.each([
    ["an unknown status", { ...valid, status: "banned" }],
    ["a blank reason", { ...valid, reason: "  " }],
    ["an empty reason", { ...valid, reason: "" }],
    ["a 501-character reason", { ...valid, reason: "x".repeat(501) }],
    ["a string actorUserId", { ...valid, actorUserId: "7" }],
    ["a zero actorUserId", { ...valid, actorUserId: 0 }],
    ["a fractional actorUserId", { ...valid, actorUserId: 1.5 }],
    ["a missing actorUserId", { status: "active", reason: "r" }],
    ["an unknown property", { ...valid, role: "admin" }],
  ])("should reject %s", async (_label, body) => {
    await expect(validateBody(InternalStatusChangeDto, body)).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("should not echo the submitted reason in the error details", async () => {
    const error = await messageOf(() => validateBody(InternalStatusChangeDto, { ...valid, status: "x", reason: "secret-reason-text" }));

    expect(JSON.stringify(error.details)).not.toContain("secret-reason-text");
  });
});

describe("UserContactResponseDto", () => {
  it("should carry exactly id, email, fullName, locale and status", () => {
    const dto = UserContactResponseDto.from({
      ...contact(5),
      // A wider object must not leak extra fields through the DTO.
      phone: "+201000000001",
      passwordHash: "$argon2id$x",
    } as UserContact);

    expect(Object.keys(dto).sort()).toEqual(["email", "fullName", "id", "locale", "status"]);
    expect(JSON.stringify(dto)).not.toContain("+201000000001");
    expect(JSON.stringify(dto)).not.toContain("argon2");
  });
});

describe("policies", () => {
  it("should require users:status:write for the status route and users:contact:read for contacts, with no ownership", () => {
    expect(internalStatusPolicy).toEqual({ kind: "service", scope: "users:status:write", owner: "none" });
    expect(internalContactsPolicy).toEqual({ kind: "service", scope: "users:contact:read", owner: "none" });
  });
});

describe("InternalUsersService.getContacts", () => {
  let written: string[];
  let accounts: { findContactsLive: jest.Mock };
  let service: InternalUsersService;

  beforeEach(() => {
    written = [];
    accounts = { findContactsLive: jest.fn().mockResolvedValue([contact(1), contact(2)]) };
    service = new InternalUsersService(
      new Logger({
        service: "identity-service",
        level: "debug",
        production: false,
        sink: (line) => {
          written.push(line);
        },
      }),
      accounts as unknown as AccountService,
    );
  });

  it("should de-duplicate ids before the single lookup", async () => {
    await service.getContacts([2, 1, 2, 1], "care-service");

    expect(accounts.findContactsLive).toHaveBeenCalledTimes(1);
    expect(accounts.findContactsLive).toHaveBeenCalledWith([2, 1]);
  });

  it("should log counts and the client id only, never an address, a name or an id", async () => {
    await service.getContacts([1, 2, 3], "care-service");

    const line = JSON.parse(written.join("").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ message: "internal_contacts_read", clientId: "care-service", requested: 3, returned: 2 });
    expect(written.join("")).not.toContain("example.test");
    expect(written.join("")).not.toContain("Amira");
  });

  it("should let a database failure propagate as is", async () => {
    accounts.findContactsLive.mockRejectedValue(new Error("connection lost"));

    await expect(service.getContacts([1], "care-service")).rejects.toThrow("connection lost");
  });
});

describe("InternalUsersController", () => {
  function fakeRes(): { res: Response; body: () => unknown } {
    let payload: unknown;
    const res = {
      locals: {},
      req: { baseUrl: "/internal/users", route: { path: "/" } },
      status() {
        return res;
      },
      json(value: unknown) {
        payload = value;
        return res;
      },
    } as unknown as Response;
    return { res, body: () => payload };
  }

  function request(overrides: Partial<Request>): Request {
    return { requestId: REQUEST_ID, params: {}, query: {}, body: {}, auth: SERVICE, ...overrides } as unknown as Request;
  }

  it("should pass the service caller, the token's client id and the body actor id to the shared transition method", async () => {
    const users = {
      applyStatusChange: jest.fn().mockResolvedValue({
        id: 42,
        status: "active",
        updatedAt: new Date("2026-10-08T10:00:00.000Z"),
        changed: true,
      }),
    };
    const controller = new InternalUsersController(
      users as unknown as UsersService,
      {} as unknown as InternalUsersService,
    );
    const { res, body } = fakeRes();

    await controller.updateUserStatus(
      request({ params: { id: "42" }, body: { status: "active", reason: "r", actorUserId: 7 } }),
      res,
    );

    expect(users.applyStatusChange).toHaveBeenCalledWith({
      targetId: 42,
      toStatus: "active",
      reason: "r",
      caller: { kind: StatusCaller.Service, actorService: "care-service", actorUserId: 7 },
      requestId: REQUEST_ID,
    });
    expect(body()).toMatchObject({ success: true, data: { id: 42, status: "active", updatedAt: "2026-10-08T10:00:00.000Z" } });
  });

  it("should fail closed with ServiceTokenRequired when the principal is not a service token", async () => {
    const controller = new InternalUsersController({} as UsersService, {} as InternalUsersService);
    const user: UserAuth = { kind: "user", userId: 1, role: "admin", status: "active", ev: true };
    const { res } = fakeRes();

    await expect(controller.getContacts(request({ auth: user, query: { ids: "1" } }), res)).rejects.toMatchObject({
      code: "ServiceTokenRequired",
    });
    await expect(controller.updateUserStatus(request({ auth: undefined }), res)).rejects.toMatchObject({
      code: "ServiceTokenRequired",
    });
  });

  it("should return the contacts through the response DTO", async () => {
    const internal = { getContacts: jest.fn().mockResolvedValue([contact(9)]) };
    const controller = new InternalUsersController({} as UsersService, internal as unknown as InternalUsersService);
    const { res, body } = fakeRes();

    await controller.getContacts(request({ query: { ids: "9,9" } }), res);

    expect(internal.getContacts).toHaveBeenCalledWith([9, 9], "care-service");
    expect(body()).toMatchObject({ success: true, data: [{ id: 9, email: "person9@example.test" }] });
  });
});

function summary(id: number): UserSummary {
  return {
    id,
    fullName: "Amira Hassan",
    avatarUrl: null,
    role: "doctor",
    status: "active",
    timezone: "Africa/Cairo",
    locale: "ar-EG",
  };
}

/** D-9 for GET /internal/users, driven through the controller exactly like the contacts route. */
describe("GET /internal/users ids validation", () => {
  const entries = (count: number): string => Array.from({ length: count }, (_v, index) => String(index + 1)).join(",");

  function call(query: Record<string, unknown>): { run: () => Promise<void>; summaries: jest.Mock } {
    const summaries = jest.fn().mockResolvedValue([]);
    const controller = new InternalUsersController(
      {} as UsersService,
      { getSummaries: summaries } as unknown as InternalUsersService,
    );
    const res = { locals: {}, status: () => res, json: () => res, req: { baseUrl: "/internal/users", route: { path: "/" } } };
    const req = { requestId: REQUEST_ID, params: {}, query, body: {}, auth: SERVICE } as unknown as Request;
    return { run: () => controller.batchGetUsers(req, res as unknown as Response), summaries };
  }

  it("should parse comma-separated canonical ids into integers and pass the token client id", async () => {
    const { run, summaries } = call({ ids: "3,1,2" });

    await run();

    expect(summaries).toHaveBeenCalledWith([3, 1, 2], "care-service");
  });

  it("should accept duplicate ids as sent and leave the collapsing to the service", async () => {
    const { run, summaries } = call({ ids: "1,1" });

    await run();

    expect(summaries).toHaveBeenCalledWith([1, 1], "care-service");
  });

  it.each(["", "1,,2", "1,", "0", "-4", "1.5", "abc", "01", "9007199254740993", " 1", "1e3", "+1"])(
    "should reject ids=%p with ValidationFailed on field ids and never query",
    async (ids) => {
      const { run, summaries } = call({ ids });

      const error = await messageOf(run);

      expect(error.code).toBe("ValidationFailed");
      expect(error.details.some((detail) => detail.field === "ids")).toBe(true);
      expect(summaries).not.toHaveBeenCalled();
    },
  );

  it("should accept 100 entries and reject 101, counting entries as sent", async () => {
    await expect(call({ ids: entries(100) }).run()).resolves.toBeUndefined();
    await expect(call({ ids: entries(101) }).run()).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(call({ ids: Array(101).fill("1").join(",") }).run()).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("should reject a missing ids, a repeated ids key and an unknown parameter", async () => {
    await expect(call({}).run()).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(call({ ids: ["1", "2"] }).run()).rejects.toMatchObject({ code: "ValidationFailed" });
    await expect(call({ ids: "1", fields: "email" }).run()).rejects.toMatchObject({ code: "ValidationFailed" });
  });

  it("should return the summaries through the response DTO and fail closed without a service principal", async () => {
    const internal = { getSummaries: jest.fn().mockResolvedValue([summary(9)]) };
    const controller = new InternalUsersController({} as UsersService, internal as unknown as InternalUsersService);
    let payload: unknown;
    const res = {
      locals: {},
      req: { baseUrl: "/internal/users", route: { path: "/" } },
      status: () => res,
      json: (value: unknown) => {
        payload = value;
        return res;
      },
    } as unknown as Response;
    const base = { requestId: REQUEST_ID, params: {}, body: {} };

    await controller.batchGetUsers({ ...base, query: { ids: "9" }, auth: SERVICE } as unknown as Request, res);
    expect(payload).toMatchObject({ success: true, data: [summary(9)] });

    const user: UserAuth = { kind: "user", userId: 1, role: "admin", status: "active", ev: true };
    await expect(
      controller.batchGetUsers({ ...base, query: { ids: "9" }, auth: user } as unknown as Request, res),
    ).rejects.toMatchObject({ code: "ServiceTokenRequired" });
  });
});

describe("UserSummaryResponseDto", () => {
  it("should carry exactly the seven contract fields and drop email, phone and hashes", () => {
    const dto = UserSummaryResponseDto.from({
      ...summary(5),
      email: "person5@example.test",
      phone: "+201000000001",
      passwordHash: "$argon2id$x",
    } as UserSummary);

    expect(Object.keys(dto).sort()).toEqual(["avatarUrl", "fullName", "id", "locale", "role", "status", "timezone"]);
    const text = JSON.stringify(dto);
    expect(text).not.toContain("example.test");
    expect(text).not.toContain("+2010");
    expect(text).not.toContain("argon2");
  });

  it("should keep a null avatar as null and a set avatar as is", () => {
    expect(UserSummaryResponseDto.from(summary(1)).avatarUrl).toBeNull();
    expect(UserSummaryResponseDto.from({ ...summary(1), avatarUrl: "https://cdn.example.test/a.png" }).avatarUrl).toBe(
      "https://cdn.example.test/a.png",
    );
  });
});

describe("internalBatchPolicy", () => {
  it("should require users:read with no ownership", () => {
    expect(internalBatchPolicy).toEqual({ kind: "service", scope: "users:read", owner: "none" });
  });
});

describe("InternalUsersService.getSummaries", () => {
  let written: string[];
  let accounts: { findSummariesLive: jest.Mock };
  let service: InternalUsersService;

  beforeEach(() => {
    written = [];
    accounts = { findSummariesLive: jest.fn().mockResolvedValue([summary(1), summary(2)]) };
    service = new InternalUsersService(
      new Logger({
        service: "identity-service",
        level: "debug",
        production: false,
        sink: (line) => {
          written.push(line);
        },
      }),
      accounts as unknown as AccountService,
    );
  });

  it("should de-duplicate ids, keeping first-seen order, before the single lookup", async () => {
    await service.getSummaries([2, 1, 2, 1], "care-service");

    expect(accounts.findSummariesLive).toHaveBeenCalledTimes(1);
    expect(accounts.findSummariesLive).toHaveBeenCalledWith([2, 1]);
  });

  it("should log counts after de-duplication and the client id only, never a name or an id list", async () => {
    await service.getSummaries([1, 2, 3, 3], "care-service");

    const line = JSON.parse(written.join("").trim()) as Record<string, unknown>;
    expect(line).toMatchObject({ message: "internal_users_read", clientId: "care-service", requested: 3, returned: 2 });
    expect(written.join("")).not.toContain("Amira");
    expect(Object.keys(line)).not.toContain("ids");
  });

  it("should return an empty list when nothing matches", async () => {
    accounts.findSummariesLive.mockResolvedValue([]);

    await expect(service.getSummaries([404], "care-service")).resolves.toEqual([]);
  });

  it("should let a database failure propagate as is", async () => {
    accounts.findSummariesLive.mockRejectedValue(new Error("connection lost"));

    await expect(service.getSummaries([1], "care-service")).rejects.toThrow("connection lost");
  });
});
