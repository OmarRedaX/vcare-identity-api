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

const PATH = "/internal/users/contacts";

let apps: { publicApp: Express; internalApp: Express };
let contactToken: string;

function contacts(query: string, token: string | null = contactToken, headers: Record<string, string> = {}): request.Test {
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

beforeAll(async () => {
  apps = buildTestApps();
  contactToken = await signCustomServiceToken({ scope: "users:contact:read", subject: "care-service" });
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("GET /internal/users/contacts: result shape", () => {
  it("should return exactly the contract's UserContact fields, no phone, with no-store", async () => {
    const patient = await seedUser({
      email: "amira.contact@example.test",
      fullName: "Amira Contact",
      phone: "+201000000055",
      locale: "ar-EG",
    });

    const response = await contacts(`?ids=${String(patient.id)}`);

    expect(response.status).toBe(200);
    expectContractDeclares("/internal/users/contacts", "get", 200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    const data = dataOf(response);
    expect(data).toEqual([
      { id: patient.id, email: "amira.contact@example.test", fullName: "Amira Contact", locale: "ar-EG", status: "active" },
    ]);
    expect(Object.keys(data[0] ?? {}).sort()).toEqual(
      inlineList(schemaBlock("UserContact"), "required").sort(),
    );
    expect(response.text).not.toContain("phone");
    expect(response.text).not.toContain("+201000000055");
  });

  it("should omit unknown and soft-deleted ids instead of failing, and return users of every status", async () => {
    const live = await seedUser({ email: "live.contact@example.test" });
    const pending = await seedUser({ email: "pending.contact@example.test", role: "doctor", status: "pending" });
    const suspended = await seedUser({ email: "suspended.contact@example.test", status: "suspended" });
    const gone = await seedUser({ email: "gone.contact@example.test" });
    await softDelete(gone.id);

    const response = await contacts(`?ids=${[live.id, pending.id, suspended.id, gone.id, 999999].join(",")}`);

    expect(response.status).toBe(200);
    const data = dataOf(response);
    expect(data.map((row) => row.id).sort()).toEqual([live.id, pending.id, suspended.id].sort());
    expect(data.find((row) => row.id === suspended.id)).toMatchObject({ status: "suspended" });
    expect(response.text).not.toContain("gone.contact@example.test");
  });

  it("should return an empty list when no id exists", async () => {
    const response = await contacts("?ids=999998,999999");

    expect(response.status).toBe(200);
    expect(dataOf(response)).toEqual([]);
  });

  it("should collapse duplicate ids and answer 200 for exactly 100 entries", async () => {
    const patient = await seedUser({ email: "dup.contact@example.test" });

    const duplicate = await contacts(`?ids=${String(patient.id)},${String(patient.id)}`);
    const hundred = await contacts(`?ids=${Array.from({ length: 100 }, (_v, index) => String(index + 1)).join(",")}`);

    expect(dataOf(duplicate)).toHaveLength(1);
    expect(hundred.status).toBe(200);
  });
});

describe("GET /internal/users/contacts: validation", () => {
  it.each([
    ["no ids", ""],
    ["an empty value", "?ids="],
    ["an empty element", "?ids=1,,2"],
    ["a trailing comma", "?ids=1,"],
    ["a zero id", "?ids=0"],
    ["a negative id", "?ids=-1"],
    ["a non-integer", "?ids=1.5"],
    ["a non-numeric id", "?ids=abc"],
    ["a leading zero", "?ids=01"],
    ["an id above the safe integer range", "?ids=9007199254740993"],
    ["a repeated ids key", "?ids=1&ids=2"],
    ["an unknown parameter", "?ids=1&email=a%40example.test"],
    ["101 entries", `?ids=${Array.from({ length: 101 }, (_v, index) => String(index + 1)).join(",")}`],
    ["101 copies of one id (the cap counts entries as sent)", `?ids=${Array(101).fill("1").join(",")}`],
  ])("should answer 400 ValidationFailed for %s", async (_label, query) => {
    const response = await contacts(query);

    expect(response.status).toBe(400);
    expectErrorEnvelope(response.body, "ValidationFailed");
    expectContractDeclares("/internal/users/contacts", "get", 400, "ValidationFailed");
  });
});

describe("GET /internal/users/contacts: RBAC", () => {
  it("should answer 401 ServiceTokenRequired without a token and for a user token of any role, an admin's included", async () => {
    const patient = await seedUser({ email: "rbac.target@example.test" });
    const query = `?ids=${String(patient.id)}`;

    const none = await contacts(query, null);
    expect(none.status).toBe(401);
    expectErrorEnvelope(none.body, "ServiceTokenRequired");

    for (const role of ["patient", "doctor", "admin"] as const) {
      const user = await seedUser({ email: `rbac.contacts.${role}@example.test`, role, status: "active" });
      const response = await contacts(query, await signAccessToken(user));
      expect(response.status).toBe(401);
      expectErrorEnvelope(response.body, "ServiceTokenRequired");
      expect(response.text).not.toContain("rbac.target@example.test");
    }
    expectContractDeclares("/internal/users/contacts", "get", 401, "ServiceTokenRequired");
  });

  it("should answer 403 InsufficientScope for every other scope, users:read included, and leak nothing", async () => {
    const patient = await seedUser({ email: "scope.target@example.test" });

    for (const scope of ["users:read", "users:status:write", "doctors:read", "users:read users:status:write"]) {
      const token = await signCustomServiceToken({ scope, subject: "care-service" });
      const response = await contacts(`?ids=${String(patient.id)}`, token);
      expect(response.status).toBe(403);
      expectErrorEnvelope(response.body, "InsufficientScope");
      expect(response.text).not.toContain("scope.target@example.test");
    }
    expectContractDeclares("/internal/users/contacts", "get", 403, "InsufficientScope");
  });

  it("should authenticate by the token alone when identity headers are spoofed", async () => {
    const response = await contacts("?ids=1", null, { "X-User-Id": "1", "X-Role": "admin" });

    expect(response.status).toBe(401);
  });

  it("should not be served by the public listener", async () => {
    const response = await request(apps.publicApp).get(`${PATH}?ids=1`).set("Authorization", `Bearer ${contactToken}`);

    expect(response.status).toBe(404);
  });

  it("should declare the operation as service-only with the contact scope in the contract", () => {
    const operation = contractOperation(PATH, "get");

    expect(operation.statuses).toEqual(expect.arrayContaining(["200", "400", "401", "403", "500"]));
    expect(operation.errorCodes.sort()).toEqual(
      ["InsufficientScope", "InternalError", "ServiceTokenRequired", "ValidationFailed"].sort(),
    );
  });
});

describe("GET /internal/users/contacts: the care-service-only scope end to end", () => {
  it("should serve a care-service token obtained through the real token endpoint", async () => {
    const client = await seedServiceClient({ scopes: ["users:read", "users:status:write", "users:contact:read"] });
    const patient = await seedUser({ email: "e2e.contact@example.test" });
    const exchange = await postToken(apps.internalApp, tokenBody(client, { scope: "users:contact:read" }));
    expect(exchange.status).toBe(200);
    const accessToken = (expectSuccessEnvelope(exchange.body) as { access_token: string }).access_token;

    const response = await contacts(`?ids=${String(patient.id)}`, accessToken);

    expect(response.status).toBe(200);
    expect(dataOf(response)[0]).toMatchObject({ email: "e2e.contact@example.test" });
  });

  it("should refuse the scope at the token endpoint for a care-service client that was not granted it", async () => {
    const client = await seedServiceClient({ scopes: ["users:read", "users:status:write"] });

    const exchange = await postToken(apps.internalApp, tokenBody(client, { scope: "users:contact:read" }));

    expect(exchange.status).toBe(403);
    expectErrorEnvelope(exchange.body, "InsufficientScope");
  });
});

describe("GET /internal/users/contacts: privacy and performance", () => {
  it("should never log an email address, a name or the requested ids", async () => {
    const patient = await seedUser({ email: "logscan.contact@example.test", fullName: "Logscan Person" });
    const logs = captureLogs();

    try {
      await contacts(`?ids=${String(patient.id)},424242`);
    } finally {
      logs.restore();
    }

    expect(logs.text()).not.toContain("logscan.contact@example.test");
    expect(logs.text()).not.toContain("Logscan Person");
    const read = logs.lines().find((line) => line.message === "internal_contacts_read");
    expect(read).toMatchObject({ clientId: "care-service", requested: 2, returned: 1 });
    expect(logs.text()).not.toContain("424242");
  });

  it("should serve the lookup from the primary key with one ANY(array) condition", async () => {
    const plan = await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL enable_seqscan = off");
      return trx.raw<{ rows: Record<string, string>[] }>(
        "EXPLAIN SELECT id, email, full_name, locale, status FROM users WHERE id = ANY(?) AND deleted_at IS NULL",
        [[1, 2, 3]],
      );
    });

    expect(plan.rows.map((row) => Object.values(row)[0]).join("\n")).toContain("users_pkey");
  });

  it("should answer a 100-id request with p95 under the 50 ms budget", async () => {
    const ids: number[] = [];
    for (let index = 0; index < 100; index += 1) {
      ids.push(
        (await seedUser({ email: `perf.${String(index)}@example.test`, passwordHash: "$argon2id$v=19$m=19456,t=2,p=1$c29tZXNhbHQ$aGFzaA" })).id,
      );
    }
    const query = `?ids=${ids.join(",")}`;
    await contacts(query).expect(200);

    const samples: number[] = [];
    for (let run = 0; run < 30; run += 1) {
      const started = process.hrtime.bigint();
      const response = await contacts(query);
      samples.push(Number(process.hrtime.bigint() - started) / 1e6);
      expect(response.status).toBe(200);
      expect(dataOf(response)).toHaveLength(100);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95) - 1] ?? Number.POSITIVE_INFINITY;

    process.stderr.write(`contacts 100 ids: p95=${p95.toFixed(1)} ms, max=${(samples.at(-1) ?? 0).toFixed(1)} ms\n`);
    expect(p95).toBeLessThan(50);
  });
});
