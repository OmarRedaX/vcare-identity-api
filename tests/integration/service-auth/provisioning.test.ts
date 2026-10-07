import { spawnSync } from "node:child_process";
import path from "node:path";
import type { Express } from "express";
import { buildTestApps } from "../../helpers/app";
import { closeDb, truncateAll } from "../../helpers/db";
import { closeRedis, flushTestKeys } from "../../helpers/redis";
import { postToken, tokenBody } from "../../helpers/service-clients";
import { db } from "../../../src/lib/knex/knex";

/**
 * End to end for the ops procedure (spec section 6.1): the SQL the script prints runs against the real table,
 * satisfies its CHECK constraints, and the secret printed on stderr then authenticates at the token endpoint.
 */
const TSX = path.resolve(process.cwd(), "node_modules/tsx/dist/cli.mjs");
const SCRIPT = path.resolve(process.cwd(), "scripts/provision-service-client.ts");

let internalApp: Express;

interface Provisioned {
  sql: string;
  secret: string;
}

function provision(args: string[]): Provisioned {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DATABASE_URL;
  const result = spawnSync(process.execPath, [TSX, SCRIPT, ...args], { encoding: "utf8", env, timeout: 120_000 });
  if (result.status !== 0) {
    throw new Error("provisioning script failed");
  }
  const lines = result.stderr.split("\n").map((line) => line.trim());
  const secret = lines[lines.findIndex((line) => line.includes("CLIENT SECRET")) + 1] ?? "";
  return { sql: result.stdout.trim(), secret };
}

function exchange(secret: string) {
  return postToken(internalApp, tokenBody({ id: 0, clientId: "ops-client", secret }));
}

beforeAll(() => {
  internalApp = buildTestApps().internalApp;
});

beforeEach(async () => {
  await truncateAll();
  await flushTestKeys();
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe("service client provisioning SQL", () => {
  it("should register a client that can exchange its printed secret, then honour the rotation overlap", async () => {
    const created = provision([
      "--client-id", "ops-client", "--name", "Ops client",
      "--scopes", "users:read", "--audiences", "vcare-identity",
    ]);
    await db.raw(created.sql);

    const rotated = provision(["--client-id", "ops-client", "--rotate", "--overlap-hours", "2"]);
    const updated = await db.raw<{ rowCount: number }>(rotated.sql);

    expect(updated.rowCount).toBe(1);
    expect((await exchange(rotated.secret)).status).toBe(200);
    expect((await exchange(created.secret)).status).toBe(200);
  });

  it("should stop honouring the old secret immediately after a --leaked rotation", async () => {
    const created = provision([
      "--client-id", "ops-client", "--name", "Ops client",
      "--scopes", "users:read", "--audiences", "vcare-identity",
    ]);
    await db.raw(created.sql);
    expect((await exchange(created.secret)).status).toBe(200);

    const leaked = provision(["--client-id", "ops-client", "--rotate", "--leaked"]);
    await db.raw(leaked.sql);

    expect((await exchange(leaked.secret)).status).toBe(200);
    expect((await exchange(created.secret)).status).toBe(401);
  });

  it("should store only argon2id hashes and never the plaintext secret", async () => {
    const created = provision([
      "--client-id", "ops-client", "--name", "Ops client",
      "--scopes", "users:read", "--audiences", "vcare-identity",
    ]);

    await db.raw(created.sql);

    const row = await db("service_clients").first<{ client_secret_hash: string }>("client_secret_hash");
    expect(row?.client_secret_hash).toMatch(/^\$argon2id\$/);
    expect(created.sql).not.toContain(created.secret);
    expect(JSON.stringify(row)).not.toContain(created.secret);
  });
});
