import type { Express } from "express";
import request from "supertest";
import { db } from "../../../src/lib/knex/knex";
import { buildTestApps } from "../../helpers/app";
import { seedUser, softDelete } from "../../helpers/auth";
import {
  contractOperation,
  expectContractDeclares,
  expectErrorEnvelope,
  expectSuccessEnvelope,
  inlineList,
  schemaBlock,
} from "../../helpers/contract";
import { closeDb, truncateAll } from "../../helpers/db";
import { captureLogs } from "../../helpers/log-capture";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { postToken, seedServiceClient, tokenBody } from "../../helpers/service-clients";
import { signAccessToken, signCustomServiceToken } from "../../helpers/tokens";

const PATH = "/internal/users";
const SUMMARY_FIELDS = ["avatarUrl", "fullName", "id", "locale", "role", "status", "timezone"];

let apps: { publicApp: Express; internalApp: Express };
let readToken: string;

function batch(query: string, token: string | null = readToken, headers: Record<string, string> = {}): request.Test {
  const call = request(apps.internalApp).get(`${PATH}${query}`);
  if (token !== null) {
    void call.set("Authorization", `Bearer ${token}`);
  }
  for (const [name, value] of Object.entries(headers)) {
    void call.set(name, value);
  }
  return call;
}

function dataOf(response: request.Response): Record<string, unknown>[] {
  return expectSuccessEnvelope(response.body) as Record<string, unknown>[];
}

function range(count: number): string {
  return Array.from({ length: count }, (_v, index) => String(index + 1)).join(",");
}

beforeAll(async () => {
  apps = buildTestApps();
  readToken = await signCustomServiceToken({ scope: "users:read", subject: "care-service" });
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("GET /internal/users: Case 2 result shape", () => {
  it("should return exactly the contract's UserSummary fields for a live user and never email or phone", async () => {
    const doctor = await seedUser({
      email: "summary.doctor@example.test",
      fullName: "Dr Summary Person",
      phone: "+201000000077",
      role: "doctor",
      status: "pending",
      timezone: "Europe/Berlin",
      locale: "de-DE",
    });
    await db("users").where("id", doctor.id).update({ avatar_url: "https://cdn.example.test/avatars/1.png" });

    const response = await batch(`?ids=${String(doctor.id)}`);

    expect(response.status).toBe(200);
    expectContractDeclares(PATH, "get", 200);
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const data = dataOf(response);
    expect(data).toEqual([
      {
        id: doctor.id,
        fullName: "Dr Summary Person",
        avatarUrl: "https://cdn.example.test/avatars/1.png",
        role: "doctor",
        status: "pending",
        timezone: "Europe/Berlin",
        locale: "de-DE",
      },
    ]);
    expect(Object.keys(data[0] ?? {}).sort()).toEqual(inlineList(schemaBlock("UserSummary"), "required").sort());
    expect(Object.keys(data[0] ?? {}).sort()).toEqual(SUMMARY_FIELDS);
    expect(response.text.toLowerCase()).not.toContain("email");
    expect(response.text).not.toContain("phone");
    expect(response.text).not.toContain("summary.doctor@example.test");
    expect(response.text).not.toContain("+201000000077");
    expect(response.text).not.toMatch(/hash|argon2/i);
  });

  it("should return a null avatarUrl, not an absent key, when the user has none", async () => {
    const patient = await seedUser({ email: "noavatar@example.test" });

    const data = dataOf(await batch(`?ids=${String(patient.id)}`));

    expect(data).toHaveLength(1);
    expect(data[0]).toHaveProperty("avatarUrl", null);
  });

  it("should return users of every role and status", async () => {
    const patient = await seedUser({ email: "all.patient@example.test" });
    const suspended = await seedUser({ email: "all.suspended@example.test", status: "suspended" });
    const rejected = await seedUser({ email: "all.rejected@example.test", role: "doctor", status: "rejected" });
    const admin = await seedUser({ email: "all.admin@example.test", role: "admin" });

    const data = dataOf(await batch(`?ids=${[patient.id, suspended.id, rejected.id, admin.id].join(",")}`));

    const byId = new Map(data.map((row) => [row.id, row]));
    expect(byId.size).toBe(4);
    expect(byId.get(suspended.id)).toMatchObject({ role: "patient", status: "suspended" });
    expect(byId.get(rejected.id)).toMatchObject({ role: "doctor", status: "rejected" });
    expect(byId.get(admin.id)).toMatchObject({ role: "admin", status: "active" });
  });

  it("should omit unknown and soft-deleted ids instead of failing", async () => {
    const live = await seedUser({ email: "live.summary@example.test" });
    const gone = await seedUser({ email: "gone.summary@example.test", fullName: "Gone Person" });
    await softDelete(gone.id);

    const response = await batch(`?ids=${[live.id, gone.id, 999999].join(",")}`);

    expect(response.status).toBe(200);
    expect(dataOf(response).map((row) => row.id)).toEqual([live.id]);
    expect(response.text).not.toContain("Gone Person");
  });

  it("should answer 200 with an empty list when no id exists", async () => {
    const response = await batch("?ids=999998,999999");

    expect(response.status).toBe(200);
    expect(dataOf(response)).toEqual([]);
  });

  it("should collapse duplicate ids and a repeated id into one row each", async () => {
    const patient = await seedUser({ email: "dup.summary@example.test" });
    const other = await seedUser({ email: "dup.other@example.test" });

    const response = await batch(`?ids=${[patient.id, patient.id, other.id, patient.id].join(",")}`);

    expect(response.status).toBe(200);
    expect(
      dataOf(response)
        .map((row) => row.id)
        .sort(),
    ).toEqual([patient.id, other.id].sort());
  });

  it("should answer 200 for exactly 100 entries and return the live ones among them", async () => {
    const seeded = await seedUser({ email: "hundred@example.test" });

    const response = await batch(`?ids=${[seeded.id, ...Array.from({ length: 99 }, (_v, index) => 900000 + index)].join(",")}`);

    expect(response.status).toBe(200);
    expect(dataOf(response)).toHaveLength(1);
  });

  it("should return all 100 summaries when 100 distinct live users are requested", async () => {
    const ids: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      ids.push(
        (
          await seedUser({
            email: `bulk.${String(index)}@example.test`,
            passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA",
          })
        ).id,
      );
    }

    const response = await batch(`?ids=${ids.join(",")}`);

    expect(response.status).toBe(200);
    expect(dataOf(response)).toHaveLength(100);
  });

  it("should not declare Cache-Control: no-store because the shape carries no personal contact data", async () => {
    const patient = await seedUser({ email: "cache.summary@example.test" });

    const response = await batch(`?ids=${String(patient.id)}`);

    expect(String(response.headers["cache-control"] ?? "")).not.toContain("no-store");
  });
});

describe("GET /internal/users: ids validation", () => {
  it.each([
    ["no ids", ""],
    ["an empty value", "?ids="],
    ["an empty element", "?ids=1,,2"],
    ["a trailing comma", "?ids=1,"],
    ["a leading comma", "?ids=,1"],
    ["a zero id", "?ids=0"],
    ["a negative id", "?ids=-1"],
    ["a non-integer", "?ids=1.5"],
    ["a non-numeric id", "?ids=abc"],
    ["a leading zero", "?ids=01"],
    ["an exponent", "?ids=1e3"],
    ["an id above the safe integer range", "?ids=9007199254740993"],
    ["a repeated ids key", "?ids=1&ids=2"],
    ["an unknown parameter", "?ids=1&email=a%40example.test"],
    ["101 entries", `?ids=${range(101)}`],
    ["101 copies of one id (the cap counts entries as sent)", `?ids=${Array(101).fill("1").join(",")}`],
  ])("should answer 400 ValidationFailed for %s", async (_label, query) => {
    const response = await batch(query);

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expectContractDeclares(PATH, "get", 400, "ValidationFailed");
  });
});

describe("GET /internal/users: RBAC", () => {
  it("should answer 401 ServiceTokenRequired without a token and for a user token of any role, an admin's included", async () => {
    const patient = await seedUser({ email: "rbac.batch.target@example.test", fullName: "Target Person" });
    const query = `?ids=${String(patient.id)}`;

    const none = await batch(query, null);
    expect(none.status).toBe(401);
    expectErrorEnvelope(none.body, "ServiceTokenRequired");

    for (const role of ["patient", "doctor", "admin"] as const) {
      const user = await seedUser({ email: `rbac.batch.${role}@example.test`, role, status: "active" });
      const response = await batch(query, await signAccessToken(user));
      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, "ServiceTokenRequired");
      expect(response.text).not.toContain("Target Person");
    }
    expectContractDeclares(PATH, "get", 401, "ServiceTokenRequired");
  });

  it("should answer 403 InsufficientScope for every other scope and leak nothing", async () => {
    const patient = await seedUser({ email: "scope.batch.target@example.test", fullName: "Scoped Person" });

    for (const scope of ["users:status:write", "users:contact:read", "doctors:read", "users:contact:read users:status:write"]) {
      const token = await signCustomServiceToken({ scope, subject: "care-service" });
      const response = await batch(`?ids=${String(patient.id)}`, token);
      expect(response.status).toBe(403);
      expectErrorEnvelope(response.body, "InsufficientScope");
      expect(response.text).not.toContain("Scoped Person");
    }
    expectContractDeclares(PATH, "get", 403, "InsufficientScope");
  });

  it("should answer 403 InsufficientScope, not 400, when a scope-less caller also sends bad ids (scope is checked first)", async () => {
    const token = await signCustomServiceToken({ scope: "doctors:read", subject: "care-service" });

    const response = await batch("?ids=abc", token);

    expect(response.status).toBe(403);
    expectErrorEnvelope(response.body, "InsufficientScope");
  });

  it("should accept a token holding users:read among several scopes", async () => {
    const patient = await seedUser({ email: "multi.scope@example.test" });
    const token = await signCustomServiceToken({ scope: "users:status:write users:read", subject: "care-service" });

    const response = await batch(`?ids=${String(patient.id)}`, token);

    expect(response.status).toBe(200);
  });

  it("should authenticate by the token alone when identity headers are spoofed", async () => {
    const withoutToken = await batch("?ids=1", null, { "X-User-Id": "1", "X-Role": "admin", "X-Forwarded-User": "1" });
    const patient = await seedUser({ email: "spoof.target@example.test" });
    const wrongScope = await batch(
      `?ids=${String(patient.id)}`,
      await signCustomServiceToken({ scope: "doctors:read", subject: "care-service" }),
      { "X-User-Id": "1", "X-Role": "admin" },
    );
    const withToken = await batch(`?ids=${String(patient.id)}`, readToken, { "X-User-Id": "999", "X-Role": "patient" });

    expect(withoutToken.status).toBe(401);
    expect(wrongScope.status).toBe(403);
    expect(withToken.status).toBe(200);
    expect(dataOf(withToken)).toHaveLength(1);
  });

  it("should not be served by the public listener", async () => {
    const response = await request(apps.publicApp).get(`${PATH}?ids=1`).set("Authorization", `Bearer ${readToken}`);

    expect(response.status).toBe(404);
  });

  it("should declare the operation as service-only with the read scope in the contract", () => {
    const operation = contractOperation(PATH, "get");

    expect(operation.statuses).toEqual(expect.arrayContaining(["200", "400", "401", "403", "500"]));
    expect(operation.errorCodes.sort()).toEqual(
      ["InsufficientScope", "InternalError", "ServiceTokenRequired", "ValidationFailed"].sort(),
    );
  });
});

describe("GET /internal/users: the scope end to end", () => {
  it("should serve a care-service token obtained through the real token endpoint", async () => {
    const client = await seedServiceClient({ scopes: ["users:read"] });
    const patient = await seedUser({ email: "e2e.batch@example.test" });
    const exchange = await postToken(apps.internalApp, tokenBody(client, { scope: "users:read" }));
    expect(exchange.status).toBe(200);
    const accessToken = (expectSuccessEnvelope(exchange.body) as { access_token: string }).access_token;

    const response = await batch(`?ids=${String(patient.id)}`, accessToken);

    expect(response.status).toBe(200);
    expect(dataOf(response)[0]).toMatchObject({ id: patient.id, fullName: "Amira Hassan" });
  });
});

describe("GET /internal/users: privacy", () => {
  it("should log the client id and counts only, never a name, an address or the requested ids", async () => {
    const patient = await seedUser({ email: "logscan.batch@example.test", fullName: "Logscan Batch Person" });
    const logs = captureLogs();

    try {
      await batch(`?ids=${String(patient.id)},424242,424242`);
    } finally {
      logs.restore();
    }

    expect(logs.text()).not.toContain("logscan.batch@example.test");
    expect(logs.text()).not.toContain("Logscan Batch Person");
    expect(logs.text()).not.toContain("424242");
    const read = logs.lines().find((line) => line.message === "internal_users_read");
    expect(read).toMatchObject({ clientId: "care-service", requested: 2, returned: 1 });
  });
});
