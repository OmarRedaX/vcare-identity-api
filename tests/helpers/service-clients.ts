import argon2 from "argon2";
import type { Express } from "express";
import request from "supertest";
import { db } from "../../src/lib/knex/knex";
import { ARGON2_PARAMETERS } from "../../src/lib/password/password-hasher";
import { randomToken } from "../../src/pkg/utils/crypto";
import type { SeededServiceClient, SeedServiceClientOptions } from "./types";

export const TEST_CLIENT_ID = "care-service";

/** argon2 is deliberately slow; each distinct secret is hashed once per run. */
const hashCache = new Map<string, string>();

export async function hashSecret(secret: string): Promise<string> {
  const cached = hashCache.get(secret);
  if (cached !== undefined) {
    return cached;
  }
  const hash = await argon2.hash(secret, { type: argon2.argon2id, ...ARGON2_PARAMETERS });
  hashCache.set(secret, hash);
  return hash;
}

/**
 * Registers a synthetic client the way ops SQL would, but with the real argon2id parameters. Integration tests
 * never use the seed script (spec section 6.2).
 */
export async function seedServiceClient(
  options: SeedServiceClientOptions = {},
): Promise<SeededServiceClient> {
  const clientId = options.clientId ?? TEST_CLIENT_ID;
  const secret = options.secret ?? randomToken(32);
  const previous = options.previous;

  const inserted = await db("service_clients")
    .insert({
      client_id: clientId,
      name: options.name ?? "Care service (test)",
      client_secret_hash: await hashSecret(secret),
      previous_secret_hash: previous === undefined ? null : await hashSecret(previous.secret),
      previous_secret_expires_at: previous === undefined ? null : previous.expiresAt,
      allowed_scopes: options.scopes ?? ["users:read", "users:status:write"],
      allowed_audiences: options.audiences ?? ["vcare-identity"],
      is_active: options.isActive ?? true,
      deleted_at: options.deletedAt ?? null,
    })
    .returning("id");

  const row = (inserted as { id: string | number }[])[0];
  if (row === undefined) {
    throw new Error("seed_service_client_returned_no_row");
  }
  return { id: Number(row.id), clientId, secret };
}

export function tokenBody(
  seeded: SeededServiceClient,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    grant_type: "client_credentials",
    client_id: seeded.clientId,
    client_secret: seeded.secret,
    scope: "users:read",
    audience: "vcare-identity",
    ...overrides,
  };
}

export function postToken(
  app: Express,
  body: Record<string, unknown>,
  requestId?: string,
): request.Test {
  const call = request(app).post("/internal/auth/token").send(body);
  return requestId === undefined ? call : call.set("X-Request-Id", requestId);
}

export function postTokenForm(app: Express, body: Record<string, string | string[]>): request.Test {
  const pairs = Object.entries(body).flatMap(([key, value]) =>
    (Array.isArray(value) ? value : [value]).map(
      (entry) => `${encodeURIComponent(key)}=${encodeURIComponent(entry)}`,
    ),
  );
  return request(app)
    .post("/internal/auth/token")
    .set("Content-Type", "application/x-www-form-urlencoded")
    .send(pairs.join("&"));
}

export async function lastUsedAt(id: number): Promise<Date | null> {
  const row = await db("service_clients").where("id", id).first<{ last_used_at: Date | null }>();
  return row?.last_used_at ?? null;
}

/** Waits for the fire-and-forget `last_used_at` touch (D-11) to land, or gives up after about a second. */
export async function waitForLastUsed(id: number, expected: Date | null = null): Promise<Date | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const value = await lastUsedAt(id);
    if (value !== null && (expected === null || value.getTime() === expected.getTime())) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return lastUsedAt(id);
}
