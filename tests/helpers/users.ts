import type { Express } from "express";
import type { Knex } from "knex";
import request from "supertest";
import * as refreshTokens from "../../src/app/auth/repository/refresh-token.repo";
import type { User } from "../../src/app/auth/entity/user.entity";
import { db } from "../../src/lib/knex/knex";
import { randomToken, randomUuid, sha256Hex } from "../../src/pkg/utils/crypto";
import { hashPassword, seedUser } from "./auth";
import { signAccessToken } from "./tokens";

export interface HistoryRow {
  id: string;
  user_id: string;
  from_status: string;
  to_status: string;
  actor_user_id: string | null;
  actor_service: string | null;
  reason: string;
  request_id: string;
  created_at: Date;
}

export interface TokenRow {
  id: string;
  user_id: string;
  family_id: string;
  revoked_at: Date | null;
  revoked_reason: string | null;
  replaced_by_id: string | null;
  device_info: string | null;
  expires_at: Date;
  created_at: Date;
}

export interface SeedRow {
  email: string;
  createdAt: string;
  role?: "patient" | "doctor" | "admin";
  status?: "pending" | "active" | "suspended" | "rejected";
}

export interface Admin {
  user: User;
  token: string;
}

/** Substrings that must never appear in any users-module response body. */
export const SECRET_MARKERS = ["password_hash", "passwordHash", "token_hash", "tokenHash", "$argon2", "deletedAt"];

export async function seedAdmin(email = "admin.one@example.test"): Promise<Admin> {
  const user = await seedUser({ email, role: "admin", fullName: "Admin One" });
  return { user, token: await signAccessToken(user) };
}

export function authed(call: request.Test, token: string | undefined): request.Test {
  return token === undefined ? call : call.set("Authorization", `Bearer ${token}`);
}

export function listUsers(
  app: Express,
  token: string | undefined,
  query: Record<string, string> = {},
): request.Test {
  return authed(request(app).get("/api/users").query(query), token);
}

export function getUser(app: Express, token: string | undefined, id: number | string): request.Test {
  return authed(request(app).get(`/api/users/${String(id)}`), token);
}

export function patchStatus(
  app: Express,
  token: string | undefined,
  id: number | string,
  body: unknown,
  headers: Record<string, string> = {},
): request.Test {
  const call = authed(request(app).patch(`/api/users/${String(id)}/status`), token);
  for (const [name, value] of Object.entries(headers)) {
    void call.set(name, value);
  }
  return call.send(body as object);
}

export function listSessions(
  app: Express,
  token: string | undefined,
  id: number | string,
  query: Record<string, string> = {},
): request.Test {
  return authed(request(app).get(`/api/users/${String(id)}/sessions`).query(query), token);
}

export function revokeSessions(app: Express, token: string | undefined, id: number | string): request.Test {
  return authed(request(app).delete(`/api/users/${String(id)}/sessions`), token);
}

/**
 * Inserts accounts straight into the real table with chosen `created_at` values, so tests can create rows that
 * share a millisecond (or a microsecond) — something the API cannot do. Real DB write, no mocks.
 */
export async function insertUserRows(rows: SeedRow[]): Promise<number[]> {
  const passwordHash = await hashPassword();
  const ids: number[] = [];
  for (const row of rows) {
    const inserted = await db("users")
      .insert({
        email: row.email,
        phone: null,
        password_hash: passwordHash,
        full_name: "Synthetic Person",
        avatar_url: null,
        role: row.role ?? "patient",
        status: row.status ?? "active",
        email_verified_at: db.raw("now()"),
        timezone: "Africa/Cairo",
        locale: "ar-EG",
        created_at: db.raw("?::timestamptz", [row.createdAt]),
        updated_at: db.raw("?::timestamptz", [row.createdAt]),
      })
      .returning("id");
    ids.push(Number((inserted as { id: string | number }[])[0]?.id));
  }
  return ids;
}

/** A live refresh-token family through the real repository (no argon2, no login rate limit). Returns the raw token. */
export async function seedSession(
  userId: number,
  options: { deviceInfo?: string | null; createdAt?: string; familyId?: string } = {},
): Promise<{ token: string; familyId: string; id: number }> {
  const token = randomToken();
  const familyId = options.familyId ?? randomUuid();
  const id = await refreshTokens.insertToken({
    userId,
    familyId,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(Date.now() + 30 * 86_400_000),
    deviceInfo: options.deviceInfo ?? null,
  });
  if (options.createdAt !== undefined) {
    await db("refresh_tokens")
      .where("id", id)
      .update({ created_at: db.raw("?::timestamptz", [options.createdAt]) });
  }
  return { token, familyId, id };
}

export function tokenRows(userId?: number): Promise<TokenRow[]> {
  const query = db<TokenRow>("refresh_tokens").select("*").orderBy("id", "asc");
  return userId === undefined ? query : query.where("user_id", userId);
}

export async function liveTokenCount(userId: number, familyId?: string): Promise<number> {
  const query = db("refresh_tokens").where("user_id", userId).whereNull("revoked_at");
  if (familyId !== undefined) {
    void query.where("family_id", familyId);
  }
  const row = await query.count<{ count: string }[]>("id as count").first();
  return Number(row?.count ?? 0);
}

export function historyRows(userId?: number): Promise<HistoryRow[]> {
  const query = db<HistoryRow>("user_status_changes").select("*").orderBy("id", "asc");
  return userId === undefined ? query : query.where("user_id", userId);
}

export async function userRow(
  userId: number,
): Promise<{ status: string; updated_at: Date; deleted_at: Date | null }> {
  const row = await db("users")
    .select("status", "updated_at", "deleted_at")
    .where("id", userId)
    .first<{ status: string; updated_at: Date; deleted_at: Date | null }>();
  if (row === undefined) {
    throw new Error(`user ${String(userId)} is missing`);
  }
  return row;
}

// ── lock helpers (forced interleavings, spec 10.4) ──────────────────────────

/** A test-held transaction that owns a row lock until `commit()`, standing in for a competing request. */
export async function holdRowLock(
  table: "users" | "refresh_tokens",
  id: number,
  mode: "update" | "share",
): Promise<Knex.Transaction> {
  const trx = await db.transaction();
  const query = trx(table).select("id").where("id", id);
  await (mode === "update" ? query.forUpdate() : query.forShare()).first();
  return trx;
}

/**
 * Resolves with the SQL text of every backend currently waiting on a lock once at least `count` are waiting:
 * proof from `pg_stat_activity` that a statement is blocked at the lock boundary, not merely slow.
 */
export async function waitForBlocked(count: number, timeoutMs = 4000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await db.raw<{ rows: { query: string }[] }>(
      `SELECT query FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()`,
    );
    if (result.rows.length >= count) {
      return result.rows.map((row) => row.query);
    }
    if (Date.now() > deadline) {
      throw new Error(`expected ${String(count)} blocked statements, saw ${String(result.rows.length)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
