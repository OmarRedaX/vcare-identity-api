import { User } from "../../../../src/app/auth/entity/user.entity";
import {
  AdminStatusChangeDto,
  ListSessionsQueryDto,
  ListUsersQueryDto,
  UserIdParamDto,
} from "../../../../src/app/users/dto/users.request.dto";
import { SessionResponseDto, StatusChangeResponseDto } from "../../../../src/app/users/dto/users.response.dto";
import { UserResponseDto } from "../../../../src/app/auth/dto/auth.response.dto";
import { AppError } from "../../../../src/lib/error/AppError";
import type { ErrorDetail } from "../../../../src/lib/error/types";
import { validateBody, validateParams, validateQuery } from "../../../../src/lib/validation/validate";
import type { ClassType } from "../../../../src/lib/validation/types";

type Validator = <T extends object>(dto: ClassType<T>, input: unknown) => Promise<T>;

async function detailsOf<T extends object>(
  validator: Validator,
  dto: ClassType<T>,
  input: unknown,
): Promise<ErrorDetail[]> {
  try {
    await validator(dto, input);
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe("ValidationFailed");
    expect((err as AppError).status).toBe(400);
    return [...(err as AppError).details];
  }
  throw new Error("expected validation to fail");
}

function issueFor(details: readonly ErrorDetail[], field: string): string | undefined {
  return details.find((detail) => detail.field === field)?.issue;
}

describe("UserIdParamDto", () => {
  it("should convert a numeric path segment to an integer when the id is valid", async () => {
    await expect(validateParams(UserIdParamDto, { id: "42" })).resolves.toMatchObject({ id: 42 });
  });

  it.each(["0", "-1", "abc", "1.5", "", "9007199254740993", "1e3x"])(
    "should reject the id %p with ValidationFailed on field id",
    async (id) => {
      const details = await detailsOf(validateParams, UserIdParamDto, { id });

      expect(issueFor(details, "id")).toBeDefined();
    },
  );

  it("should reject an unknown path parameter", async () => {
    const details = await detailsOf(validateParams, UserIdParamDto, { id: "1", extra: "x" });

    expect(issueFor(details, "extra")).toBe("is not allowed");
  });
});

describe("ListUsersQueryDto", () => {
  it("should default the limit to 20 and leave every filter unset when the query is empty", async () => {
    const query = await validateQuery(ListUsersQueryDto, {});

    expect(query.limit).toBe(20);
    expect(query.role).toBeUndefined();
    expect(query.status).toBeUndefined();
    expect(query.email).toBeUndefined();
    expect(query.cursor).toBeUndefined();
  });

  it("should accept every whitelisted filter and a numeric limit given as text", async () => {
    const query = await validateQuery(ListUsersQueryDto, {
      role: "doctor",
      status: "pending",
      email: "amira.patient@example.test",
      limit: "100",
      cursor: "abc",
    });

    expect(query).toMatchObject({
      role: "doctor",
      status: "pending",
      email: "amira.patient@example.test",
      limit: 100,
    });
  });

  it.each([
    ["role", { role: "superuser" }],
    ["status", { status: "deleted" }],
    ["email", { email: "not-an-email" }],
    ["email", { email: `${"a".repeat(250)}@example.test` }],
    ["limit", { limit: "0" }],
    ["limit", { limit: "101" }],
    ["limit", { limit: "abc" }],
    ["cursor", { cursor: "c".repeat(513) }],
  ])("should reject a bad %s filter value", async (field, query) => {
    const details = await detailsOf(validateQuery, ListUsersQueryDto, query);

    expect(issueFor(details, field)).toBeDefined();
  });

  it("should reject unknown query parameters with 'is not allowed'", async () => {
    const details = await detailsOf(validateQuery, ListUsersQueryDto, { sort: "asc", deleted: "true" });

    expect(issueFor(details, "sort")).toBe("is not allowed");
    expect(issueFor(details, "deleted")).toBe("is not allowed");
  });

  it("should never echo a submitted filter value in the issue text", async () => {
    const details = await detailsOf(validateQuery, ListUsersQueryDto, { email: "private.person" });

    expect(JSON.stringify(details)).not.toContain("private.person");
  });
});

describe("ListSessionsQueryDto", () => {
  it("should accept cursor and limit only", async () => {
    await expect(validateQuery(ListSessionsQueryDto, { limit: "5", cursor: "x" })).resolves.toMatchObject({
      limit: 5,
    });
  });

  it("should reject the user-list filters because sessions have none", async () => {
    const details = await detailsOf(validateQuery, ListSessionsQueryDto, { role: "patient", status: "active" });

    expect(issueFor(details, "role")).toBe("is not allowed");
    expect(issueFor(details, "status")).toBe("is not allowed");
  });
});

describe("AdminStatusChangeDto", () => {
  it.each(["active", "suspended"])("should accept status %s with a reason", async (status) => {
    await expect(validateBody(AdminStatusChangeDto, { status, reason: "synthetic reason" })).resolves.toMatchObject({
      status,
      reason: "synthetic reason",
    });
  });

  it.each(["pending", "rejected", "deleted", "ACTIVE", ""])(
    "should reject the status %p because the contract enum is active and suspended only",
    async (status) => {
      const details = await detailsOf(validateBody, AdminStatusChangeDto, { status, reason: "r" });

      expect(issueFor(details, "status")).toBeDefined();
    },
  );

  it.each(["", "   ", "\n\t "])("should reject the blank reason %p", async (reason) => {
    const details = await detailsOf(validateBody, AdminStatusChangeDto, { status: "suspended", reason });

    expect(issueFor(details, "reason")).toBeDefined();
  });

  it("should accept a reason of exactly 500 characters and reject 501", async () => {
    await expect(
      validateBody(AdminStatusChangeDto, { status: "suspended", reason: "r".repeat(500) }),
    ).resolves.toBeDefined();

    const details = await detailsOf(validateBody, AdminStatusChangeDto, {
      status: "suspended",
      reason: "r".repeat(501),
    });
    expect(issueFor(details, "reason")).toBeDefined();
  });

  it("should reject a non-string reason and a missing field", async () => {
    expect(
      issueFor(await detailsOf(validateBody, AdminStatusChangeDto, { status: "active", reason: 5 }), "reason"),
    ).toBeDefined();
    expect(issueFor(await detailsOf(validateBody, AdminStatusChangeDto, { status: "active" }), "reason")).toBeDefined();
    expect(issueFor(await detailsOf(validateBody, AdminStatusChangeDto, { reason: "r" }), "status")).toBeDefined();
  });

  it("should reject an unknown field such as role, email or actorUserId", async () => {
    const details = await detailsOf(validateBody, AdminStatusChangeDto, {
      status: "active",
      reason: "r",
      role: "admin",
      actorUserId: 1,
    });

    expect(issueFor(details, "role")).toBe("is not allowed");
    expect(issueFor(details, "actorUserId")).toBe("is not allowed");
  });

  it("should reject a body that is not a JSON object", async () => {
    const details = await detailsOf(validateBody, AdminStatusChangeDto, ["active"]);

    expect(issueFor(details, "body")).toBe("must be a JSON object");
  });
});

describe("response DTOs (no secret fields)", () => {
  const NOW = new Date("2026-10-07T10:00:00.000Z");

  it("should expose only the contract User fields and never a password hash or deletedAt", () => {
    const dto = UserResponseDto.from(
      new User({
        id: 5,
        email: "amira.patient@example.test",
        phone: null,
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
      }),
    );

    expect(Object.keys(dto).sort()).toEqual(
      [
        "avatarUrl",
        "createdAt",
        "email",
        "emailVerifiedAt",
        "fullName",
        "id",
        "locale",
        "phone",
        "role",
        "status",
        "timezone",
        "updatedAt",
      ].sort(),
    );
    expect(JSON.stringify(dto)).not.toContain("argon2");
  });

  it("should map a live family to the five Session fields as ISO strings, with no token, hash, or user id", () => {
    const dto = SessionResponseDto.from({
      familyId: "8f1c4e2a-0000-4000-8000-000000000001",
      deviceInfo: "jest-agent",
      createdAt: NOW,
      createdAtCursor: "2026-10-07T10:00:00.000000Z",
      lastUsedAt: new Date("2026-10-07T10:05:00.000Z"),
      expiresAt: new Date("2026-11-06T10:05:00.000Z"),
    });

    expect(JSON.parse(JSON.stringify(dto))).toEqual({
      familyId: "8f1c4e2a-0000-4000-8000-000000000001",
      deviceInfo: "jest-agent",
      createdAt: "2026-10-07T10:00:00.000Z",
      lastUsedAt: "2026-10-07T10:05:00.000Z",
      expiresAt: "2026-11-06T10:05:00.000Z",
    });
  });

  it("should map a status change result to id, status and updatedAt only", () => {
    const dto = StatusChangeResponseDto.from({ id: 9, status: "suspended" as never, updatedAt: NOW, changed: true });

    expect(JSON.parse(JSON.stringify(dto))).toEqual({
      id: 9,
      status: "suspended",
      updatedAt: "2026-10-07T10:00:00.000Z",
    });
  });
});
