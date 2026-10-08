import { db } from "../../../src/lib/knex/knex";
import { SERVICE_SCOPES } from "../../../src/lib/auth/constants";
import * as migration from "../../../src/migrations/20261007000300_create_service_clients";
import { closeDb, truncateAll } from "../../helpers/db";
import { hashSecret } from "../../helpers/service-clients";

const HASH_SECRET = "schema-fixture-secret-schema-fixture-secret";

async function validRow(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  return {
    client_id: "care-service",
    name: "Care service (test)",
    client_secret_hash: await hashSecret(HASH_SECRET),
    allowed_scopes: ["users:read"],
    allowed_audiences: ["vcare-identity"],
    is_active: true,
    ...overrides,
  };
}

async function insertRejectedBy(constraint: string, overrides: Record<string, unknown>): Promise<void> {
  await expect(db("service_clients").insert(await validRow(overrides))).rejects.toMatchObject({ constraint });
}

beforeEach(async () => {
  await truncateAll();
});

afterAll(async () => {
  await closeDb();
});

describe("service_clients: CHECK constraints", () => {
  it("should accept a fully valid row when every constraint is satisfied", async () => {
    await expect(db("service_clients").insert(await validRow())).resolves.toBeDefined();
  });

  it("should reject a client_id that is not lowercase kebab-case starting with a letter", async () => {
    for (const clientId of ["Care-Service", "ab", "1care", "care_service"]) {
      await insertRejectedBy("chk_service_clients_client_id", { client_id: clientId });
    }
  });

  it("should reject a blank name", async () => {
    await insertRejectedBy("chk_service_clients_name_not_blank", { name: "   " });
  });

  it("should reject a client_secret_hash or previous_secret_hash that is not argon2id", async () => {
    await insertRejectedBy("chk_service_clients_secret_hash_argon2id", { client_secret_hash: "plaintext-secret" });
    await insertRejectedBy("chk_service_clients_secret_hash_argon2id", {
      client_secret_hash: "$2b$10$abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234",
    });
    await insertRejectedBy("chk_service_clients_previous_hash_argon2id", {
      previous_secret_hash: "plaintext-secret",
      previous_secret_expires_at: new Date(),
    });
  });

  it("should require previous_secret_hash and previous_secret_expires_at to be set or null together", async () => {
    await insertRejectedBy("chk_service_clients_previous_secret_pair", {
      previous_secret_hash: await hashSecret(HASH_SECRET),
      previous_secret_expires_at: null,
    });
    await insertRejectedBy("chk_service_clients_previous_secret_pair", {
      previous_secret_hash: null,
      previous_secret_expires_at: new Date(),
    });
  });

  it("should reject allowed_scopes outside the vocabulary or empty", async () => {
    await insertRejectedBy("chk_service_clients_allowed_scopes", { allowed_scopes: ["users:write"] });
    await insertRejectedBy("chk_service_clients_allowed_scopes", { allowed_scopes: ["users:read", "foo:bar"] });
    await insertRejectedBy("chk_service_clients_allowed_scopes_nonempty", { allowed_scopes: [] });
  });

  it("should reject allowed_audiences that are empty, not vcare-prefixed, malformed or contain a NULL element", async () => {
    for (const audiences of [[], ["care"], ["vcare-identity", "Bad"], ["vcare-a,b"], ["vcare-identity", null], ["vcare-"]]) {
      await insertRejectedBy("chk_service_clients_allowed_audiences_shape", { allowed_audiences: audiences });
    }
  });

  it("should accept several valid audiences", async () => {
    await expect(
      db("service_clients").insert(await validRow({ allowed_audiences: ["vcare-identity", "vcare-care-2"] })),
    ).resolves.toBeDefined();
  });

  it("should require is_active to be set explicitly because the column has no default", async () => {
    const row = await validRow();
    delete row.is_active;

    await expect(db("service_clients").insert(row)).rejects.toMatchObject({ code: "23502" });
  });

  it("should keep SERVICE_SCOPES equal to the scope vocabulary of the CHECK constraint", async () => {
    const result = await db.raw<{ rows: { definition: string }[] }>(
      "SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conname = 'chk_service_clients_allowed_scopes'",
    );

    const definition = result.rows[0]?.definition ?? "";
    const scopes = [...definition.matchAll(/'([a-z:]+)'::text/g)].map((match) => match[1]);
    expect(scopes.sort()).toEqual([...SERVICE_SCOPES].sort());
  });
});

describe("service_clients: partial unique index", () => {
  it("should reject a second live row with the same client_id", async () => {
    await db("service_clients").insert(await validRow());

    await expect(db("service_clients").insert(await validRow())).rejects.toMatchObject({
      constraint: "uq_service_clients_client_id",
    });
  });

  it("should free the client_id for reuse when the first row is soft-deleted", async () => {
    await db("service_clients").insert(await validRow({ deleted_at: new Date() }));
    await db("service_clients").insert(await validRow({ deleted_at: new Date() }));

    await expect(db("service_clients").insert(await validRow())).resolves.toBeDefined();
  });

  it("should serve the token endpoint lookup from uq_service_clients_client_id", async () => {
    await db("service_clients").insert(await validRow());

    const plan = await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL enable_seqscan = off");
      return trx.raw<{ rows: Record<string, string>[] }>(
        "EXPLAIN SELECT id FROM service_clients WHERE client_id = ? AND deleted_at IS NULL",
        ["care-service"],
      );
    });

    expect(plan.rows.map((row) => Object.values(row)[0]).join("\n")).toContain("uq_service_clients_client_id");
  });
});

describe("20261007000300_create_service_clients: down", () => {
  it("should drop the table on down and recreate it on up", async () => {
    await migration.down(db);
    const dropped = await db.raw<{ rows: { exists: string | null }[] }>(
      "SELECT to_regclass('public.service_clients') AS exists",
    );
    await migration.up(db);
    const recreated = await db.raw<{ rows: { exists: string | null }[] }>(
      "SELECT to_regclass('public.service_clients') AS exists",
    );

    expect(dropped.rows[0]?.exists).toBeNull();
    expect(recreated.rows[0]?.exists).toBe("service_clients");
  });
});
