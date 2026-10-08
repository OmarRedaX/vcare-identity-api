import type { Request, Response } from "express";
import { User } from "../../../../src/app/auth/entity/user.entity";
import { UserStatus } from "../../../../src/app/auth/enums";
import { UsersController } from "../../../../src/app/users/controller/users.controller";
import { StatusCaller } from "../../../../src/app/users/enums";
import type { UsersService } from "../../../../src/app/users/service/users.service";
import { encodeCursor, encodeKeyCursor } from "../../../../src/lib/http/pagination/cursor";
import type { UserAuth } from "../../../../src/lib/types/types";

const NOW = new Date("2026-10-07T10:00:00.000Z");
const REQUEST_ID = "7f1c0000-0000-4000-8000-0000000000aa";
const FAMILY = "8f1c4e2a-0000-4000-8000-000000000001";
const ADMIN: UserAuth = { kind: "user", userId: 1, role: "admin", status: "active", ev: true };

function user(id: number): User {
  return new User({
    id,
    email: `person${String(id)}@example.test`,
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
  });
}

interface Captured {
  status?: number;
  body?: unknown;
  ended: boolean;
}

function fakeRes(): { res: Response; captured: Captured } {
  const captured: Captured = { ended: false };
  const res = {
    locals: {},
    req: { baseUrl: "/api/users", route: { path: "/" } },
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
    end() {
      captured.ended = true;
      return res;
    },
  };
  return { res: res as unknown as Response, captured };
}

function fakeReq(parts: Partial<Request> & { auth?: UserAuth }): Request {
  return { requestId: REQUEST_ID, params: {}, query: {}, body: {}, ...parts } as unknown as Request;
}

let service: {
  getUser: jest.Mock;
  listUsers: jest.Mock;
  listSessions: jest.Mock;
  revokeSessions: jest.Mock;
  applyStatusChange: jest.Mock;
};
let controller: UsersController;

beforeEach(() => {
  service = {
    getUser: jest.fn(),
    listUsers: jest.fn(),
    listSessions: jest.fn(),
    revokeSessions: jest.fn(),
    applyStatusChange: jest.fn(),
  };
  controller = new UsersController(service as unknown as UsersService);
});

describe("UsersController.listUsers", () => {
  it("should pass only the filters that were sent, the default limit, and no cursor to the service", async () => {
    service.listUsers.mockResolvedValue({ items: [], meta: { nextCursor: null, hasMore: false, count: 0 } });
    const { res } = fakeRes();

    await controller.listUsers(fakeReq({ auth: ADMIN, query: { role: "patient" } }), res);

    expect(service.listUsers).toHaveBeenCalledWith({ role: "patient" }, undefined, 20);
  });

  it("should decode the cursor into the microsecond text and id the repository needs", async () => {
    service.listUsers.mockResolvedValue({ items: [], meta: { nextCursor: null, hasMore: false, count: 0 } });
    const { res } = fakeRes();
    const cursor = encodeCursor({ v: "2026-10-07T10:00:00.123456Z", id: 7 });

    await controller.listUsers(fakeReq({ query: { cursor, limit: "5", email: "a@example.test" } }), res);

    expect(service.listUsers).toHaveBeenCalledWith(
      { email: "a@example.test" },
      { createdAt: "2026-10-07T10:00:00.123456Z", id: 7 },
      5,
    );
  });

  it("should map items to response DTOs without the password hash and return the page meta in the envelope", async () => {
    service.listUsers.mockResolvedValue({
      items: [{ user: user(3), createdAtCursor: "x" }],
      meta: { nextCursor: "next", hasMore: true, count: 1 },
    });
    const { res, captured } = fakeRes();

    await controller.listUsers(fakeReq({ query: {} }), res);

    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      success: true,
      data: [{ id: 3, email: "person3@example.test" }],
      meta: { nextCursor: "next", hasMore: true, count: 1 },
    });
    expect(JSON.stringify(captured.body)).not.toContain("argon2");
    expect(JSON.stringify(captured.body)).not.toContain("createdAtCursor");
  });

  it("should reject a malformed cursor with ValidationFailed on field cursor before calling the service", async () => {
    const { res } = fakeRes();

    await expect(controller.listUsers(fakeReq({ query: { cursor: "garbage!!" } }), res)).rejects.toMatchObject({
      code: "ValidationFailed",
      details: [{ field: "cursor", issue: "is invalid" }],
    });
    expect(service.listUsers).not.toHaveBeenCalled();
  });

  it("should reject a cursor whose sort value is not an ISO instant", async () => {
    const { res } = fakeRes();
    const cursor = encodeCursor({ v: "yesterday", id: 7 });

    await expect(controller.listUsers(fakeReq({ query: { cursor } }), res)).rejects.toMatchObject({
      code: "ValidationFailed",
    });
  });

  it("should reject an unknown query parameter before calling the service", async () => {
    const { res } = fakeRes();

    await expect(controller.listUsers(fakeReq({ query: { sort: "asc" } }), res)).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    expect(service.listUsers).not.toHaveBeenCalled();
  });
});

describe("UsersController.getUser", () => {
  it("should validate the id and return the user in the success envelope", async () => {
    service.getUser.mockResolvedValue(user(9));
    const { res, captured } = fakeRes();

    await controller.getUser(fakeReq({ params: { id: "9" } }), res);

    expect(service.getUser).toHaveBeenCalledWith(9);
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({ success: true, data: { id: 9 } });
  });

  it.each(["0", "-3", "abc"])("should reject the id %p with ValidationFailed before calling the service", async (id) => {
    const { res } = fakeRes();

    await expect(controller.getUser(fakeReq({ params: { id } }), res)).rejects.toMatchObject({
      code: "ValidationFailed",
    });
    expect(service.getUser).not.toHaveBeenCalled();
  });
});

describe("UsersController.updateUserStatus", () => {
  it("should build an admin command from the verified token, the path id and the body, with the request id", async () => {
    service.applyStatusChange.mockResolvedValue({ id: 9, status: UserStatus.Suspended, updatedAt: NOW, changed: true });
    const { res, captured } = fakeRes();

    await controller.updateUserStatus(
      fakeReq({ auth: ADMIN, params: { id: "9" }, body: { status: "suspended", reason: "synthetic" } }),
      res,
    );

    expect(service.applyStatusChange).toHaveBeenCalledWith({
      targetId: 9,
      toStatus: "suspended",
      reason: "synthetic",
      caller: { kind: StatusCaller.Admin, actorUserId: 1 },
      requestId: REQUEST_ID,
    });
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({
      success: true,
      data: { id: 9, status: "suspended", updatedAt: "2026-10-07T10:00:00.000Z" },
    });
  });

  it("should never take the acting admin from the body", async () => {
    const { res } = fakeRes();

    await expect(
      controller.updateUserStatus(
        fakeReq({ auth: ADMIN, params: { id: "9" }, body: { status: "active", reason: "r", actorUserId: 99 } }),
        res,
      ),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(service.applyStatusChange).not.toHaveBeenCalled();
  });

  it("should throw Unauthorized when no user principal is present, as a wiring failure rather than a request", async () => {
    const { res } = fakeRes();

    await expect(
      controller.updateUserStatus(fakeReq({ params: { id: "9" }, body: { status: "active", reason: "r" } }), res),
    ).rejects.toMatchObject({ code: "Unauthorized" });
    expect(service.applyStatusChange).not.toHaveBeenCalled();
  });

  it("should reject a service principal because only a user token may drive this route", async () => {
    const { res } = fakeRes();
    const req = fakeReq({ params: { id: "9" }, body: { status: "active", reason: "r" } });
    (req as unknown as { auth: unknown }).auth = { kind: "service", clientId: "care-service", scopes: [] };

    await expect(controller.updateUserStatus(req, res)).rejects.toMatchObject({ code: "Unauthorized" });
  });

  it("should validate the body before calling the service", async () => {
    const { res } = fakeRes();

    await expect(
      controller.updateUserStatus(
        fakeReq({ auth: ADMIN, params: { id: "9" }, body: { status: "rejected", reason: "r" } }),
        res,
      ),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(service.applyStatusChange).not.toHaveBeenCalled();
  });
});

describe("UsersController.listUserSessions", () => {
  it("should decode the key cursor into createdAt and familyId for the repository", async () => {
    service.listSessions.mockResolvedValue({ items: [], meta: { nextCursor: null, hasMore: false, count: 0 } });
    const { res } = fakeRes();
    const cursor = encodeKeyCursor({ v: "2026-10-07T10:00:00.000001Z", k: FAMILY });

    await controller.listUserSessions(
      fakeReq({ params: { id: "9" }, query: { cursor, limit: "3" } }),
      res,
    );

    expect(service.listSessions).toHaveBeenCalledWith(9, { createdAt: "2026-10-07T10:00:00.000001Z", familyId: FAMILY }, 3);
  });

  it("should reject a user-list cursor, whose tiebreaker is numeric, with ValidationFailed on field cursor", async () => {
    const { res } = fakeRes();
    const cursor = encodeCursor({ v: "2026-10-07T10:00:00.000001Z", id: 5 });

    await expect(
      controller.listUserSessions(fakeReq({ params: { id: "9" }, query: { cursor } }), res),
    ).rejects.toMatchObject({ code: "ValidationFailed", details: [{ field: "cursor", issue: "is invalid" }] });
  });

  it("should map families to Session DTOs with exactly five fields", async () => {
    service.listSessions.mockResolvedValue({
      items: [
        {
          familyId: FAMILY,
          deviceInfo: null,
          createdAt: NOW,
          createdAtCursor: "x",
          lastUsedAt: NOW,
          expiresAt: NOW,
        },
      ],
      meta: { nextCursor: null, hasMore: false, count: 1 },
    });
    const { res, captured } = fakeRes();

    await controller.listUserSessions(fakeReq({ params: { id: "9" } }), res);

    const data = (captured.body as { data: Record<string, unknown>[] }).data;
    expect(Object.keys(data[0] ?? {}).sort()).toEqual(["createdAt", "deviceInfo", "expiresAt", "familyId", "lastUsedAt"]);
  });
});

describe("UsersController.revokeUserSessions", () => {
  it("should pass the token's user id and the path id and answer 204 with no body", async () => {
    service.revokeSessions.mockResolvedValue(undefined);
    const { res, captured } = fakeRes();

    await controller.revokeUserSessions(fakeReq({ auth: ADMIN, params: { id: "9" } }), res);

    expect(service.revokeSessions).toHaveBeenCalledWith(1, 9);
    expect(captured.status).toBe(204);
    expect(captured.ended).toBe(true);
    expect(captured.body).toBeUndefined();
  });

  it("should ignore a body on DELETE", async () => {
    service.revokeSessions.mockResolvedValue(undefined);
    const { res, captured } = fakeRes();

    await controller.revokeUserSessions(
      fakeReq({ auth: ADMIN, params: { id: "9" }, body: { anything: true } }),
      res,
    );

    expect(captured.status).toBe(204);
  });

  it("should reject a bad id before calling the service", async () => {
    const { res } = fakeRes();

    await expect(
      controller.revokeUserSessions(fakeReq({ auth: ADMIN, params: { id: "0" } }), res),
    ).rejects.toMatchObject({ code: "ValidationFailed" });
    expect(service.revokeSessions).not.toHaveBeenCalled();
  });
});
