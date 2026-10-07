import type { Express } from "express";
import { buildTestApps } from "../../helpers/app";
import { seedUser, softDelete } from "../../helpers/auth";
import {
  expectContractDeclares,
  expectErrorEnvelope,
  expectSuccessEnvelope,
  expectUserPayload,
} from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { getUser, SECRET_MARKERS, seedAdmin, type Admin } from "../../helpers/users";
import { db } from "../../../src/lib/knex/knex";

let apps: { publicApp: Express; internalApp: Express };
let admin: Admin;

beforeAll(() => {
  apps = buildTestApps();
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
  admin = await seedAdmin();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("GET /api/users/:id", () => {
  it("should return the contract's User with no-store when the id is live", async () => {
    const patient = await seedUser({ email: "amira.patient@example.test", phone: "+201000000001" });

    const response = await getUser(apps.publicApp, admin.token, patient.id);

    expect(response.status).toBe(200);
    expectContractDeclares("/api/users/{id}", "get", 200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const user = expectUserPayload(expectSuccessEnvelope(response.body));
    expect(user).toMatchObject({
      id: patient.id,
      email: "amira.patient@example.test",
      phone: "+201000000001",
      fullName: "Amira Hassan",
      role: "patient",
      status: "active",
      timezone: "Africa/Cairo",
      locale: "ar-EG",
    });
    expect(user.emailVerifiedAt).not.toBeNull();
    expect((response.body as { meta?: unknown }).meta).toBeUndefined();
  });

  it("should return a doctor, an admin and a suspended account to the admin whatever the role or status", async () => {
    const pending = await seedUser({ email: "pending.doctor@example.test", role: "doctor" });
    const suspended = await seedUser({ email: "suspended.patient@example.test", status: "suspended" });

    for (const [id, role, status] of [
      [pending.id, "doctor", "pending"],
      [suspended.id, "patient", "suspended"],
      [admin.user.id, "admin", "active"],
    ] as const) {
      const response = await getUser(apps.publicApp, admin.token, id);

      expect(response.status).toBe(200);
      expect(expectUserPayload(expectSuccessEnvelope(response.body))).toMatchObject({ id, role, status });
    }
  });

  it("should never carry a password hash, token hash or deletedAt in the body", async () => {
    const patient = await seedUser({ email: "secrets.patient@example.test" });
    const stored = await db("users").select("password_hash").where("id", patient.id).first<{ password_hash: string }>();

    const response = await getUser(apps.publicApp, admin.token, patient.id);

    const text = JSON.stringify(response.body);
    for (const marker of SECRET_MARKERS) {
      expect(text).not.toContain(marker);
    }
    expect(text).not.toContain(stored?.password_hash ?? "unreachable");
  });

  it("should answer 404 NotFound when the id does not exist", async () => {
    const response = await getUser(apps.publicApp, admin.token, 999_999);

    expect(response.status).toBe(404);
    expectContractDeclares("/api/users/{id}", "get", 404, "NotFound");
    expectErrorEnvelope(response.body, "NotFound");
  });

  it("should answer 404 NotFound, identical to an unknown id, when the user was soft-deleted (BR-3)", async () => {
    const patient = await seedUser({ email: "deleted.patient@example.test" });
    await softDelete(patient.id);

    const deleted = await getUser(apps.publicApp, admin.token, patient.id);
    const unknown = await getUser(apps.publicApp, admin.token, 999_999);

    expect(deleted.status).toBe(404);
    expectErrorEnvelope(deleted.body, "NotFound");
    const strip = (body: unknown): object => ({
      ...(body as { error: object }).error,
      requestId: null,
    });
    expect(strip(deleted.body)).toEqual(strip(unknown.body));
    expect(JSON.stringify(deleted.body)).not.toContain("deleted.patient@example.test");
  });

  it.each(["abc", "0", "-1", "1.5", "9007199254740993", " "])(
    "should answer 400 ValidationFailed on field id when the id is %p",
    async (id) => {
      const response = await getUser(apps.publicApp, admin.token, encodeURIComponent(id));

      expect(response.status).toBe(400);
      expectContractDeclares("/api/users/{id}", "get", 400, "ValidationFailed");
      expectErrorEnvelope(response.body, "ValidationFailed");
      const details = (response.body as { error: { details: { field: string }[] } }).error.details;
      expect(details.map((detail) => detail.field)).toContain("id");
    },
  );

  it("should answer 400 ValidationFailed when the id is a non-canonical numeral such as 1e3, 0x10, +5 or 5.0", async () => {
    for (const id of ["1e3", "0x10", "%2B5", "5.0"]) {
      const response = await getUser(apps.publicApp, admin.token, id);

      expect(response.status).toBe(400);
    }
  });
});
