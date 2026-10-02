import argon2 from "argon2";
import bcrypt from "bcrypt";
import type { Response as SupertestResponse } from "supertest";
import { AuthMailService } from "../../src/app/auth/service/auth-mail.service";
import { PurgeService } from "../../src/app/auth/service/purge.service";
import * as users from "../../src/app/auth/repository/user.repo";
import { User } from "../../src/app/auth/entity/user.entity";
import { REFRESH_COOKIE_NAME } from "../../src/lib/auth/constants";
import { env } from "../../src/lib/config/env";
import type { EmailPort } from "../../src/lib/email/types";
import { MemoryCaptureEmailAdapter } from "../../src/lib/email/memory-capture-adapter";
import { db } from "../../src/lib/knex/knex";
import { logger } from "../../src/lib/logger/logger";
import { OutboxProcessor } from "../../src/lib/outbox/outbox-processor";
import { ARGON2_PARAMETERS } from "../../src/lib/password/password-hasher";
import type { AccountStatus, Role } from "../../src/lib/rbac/types";
import type { Clock } from "../../src/lib/time/types";
import type { MutableClock, SeedUserOptions } from "./types";

export const TEST_PASSWORD = "Synthetic-Passw0rd";

/** argon2 is deliberately slow; the standard fixture password is hashed once per run. */
const hashCache = new Map<string, string>();

export async function hashPassword(password: string = TEST_PASSWORD): Promise<string> {
  const cached = hashCache.get(password);
  if (cached !== undefined) {
    return cached;
  }
  const hash = await argon2.hash(password, { type: argon2.argon2id, ...ARGON2_PARAMETERS });
  hashCache.set(password, hash);
  return hash;
}

export function bcryptHash(password: string = TEST_PASSWORD): Promise<string> {
  return bcrypt.hash(password, 10);
}

/** Seeds an account through the real repository — integration tests never mock a repository. */
export async function seedUser(options: SeedUserOptions = {}): Promise<User> {
  const role: Role = options.role ?? "patient";
  const status: AccountStatus = options.status ?? (role === "doctor" ? "pending" : "active");

  return users.insertUser({
    email: options.email ?? `user-${String(Date.now())}-${String(Math.random()).slice(2, 8)}@example.test`,
    phone: options.phone ?? null,
    passwordHash: options.passwordHash ?? (await hashPassword(options.password)),
    fullName: options.fullName ?? "Amira Hassan",
    role,
    status: status as never,
    timezone: options.timezone ?? "Africa/Cairo",
    locale: options.locale ?? "ar-EG",
  });
}

export async function setStatus(userId: number, status: AccountStatus): Promise<void> {
  await db("users").where("id", userId).update({ status, updated_at: db.raw("now()") });
}

export async function softDelete(userId: number): Promise<void> {
  await db("users").where("id", userId).update({ deleted_at: db.raw("now()") });
}

/** Moves a timestamp backwards, so expiry can be tested without faking Postgres' now(). */
export async function ageColumn(
  table: string,
  id: number,
  column: string,
  interval: string,
): Promise<void> {
  await db(table)
    .where("id", id)
    .update({ [column]: db.raw(`now() - interval '${interval}'`) });
}

export function setCookies(response: SupertestResponse): string[] {
  const header = response.headers["set-cookie"] as string[] | string | undefined;
  if (header === undefined) {
    return [];
  }
  return Array.isArray(header) ? header : [header];
}

export function refreshCookieHeader(response: SupertestResponse): string | undefined {
  return setCookies(response).find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`));
}

/** The raw refresh token from a Set-Cookie header, or undefined when the cookie clears it. */
export function refreshTokenFrom(response: SupertestResponse): string | undefined {
  const cookie = refreshCookieHeader(response);
  const value = cookie?.slice(REFRESH_COOKIE_NAME.length + 1).split(";")[0];
  return value === undefined || value.length === 0 ? undefined : value;
}

export function cookieFor(token: string): string {
  return `${REFRESH_COOKIE_NAME}=${token}`;
}

/** A clock the test moves by hand, so the grace window can be crossed without waiting. */
export function mutableClock(start: Date = new Date()): MutableClock {
  let current = new Date(start.getTime());
  const clock: Clock = { now: () => new Date(current.getTime()) };
  return {
    clock,
    advance(ms: number): void {
      current = new Date(current.getTime() + ms);
    },
    set(next: Date): void {
      current = new Date(next.getTime());
    },
  };
}

/** The real outbox processor, against the real database, with the email provider captured in memory. */
export function buildOutboxProcessor(email: EmailPort): OutboxProcessor {
  const mail = new AuthMailService(db, env, email);
  return new OutboxProcessor({
    db,
    logger,
    handlers: mail.handlers(),
    batchSize: env.WORKER_BATCH_SIZE,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS,
  });
}

export function buildPurgeService(): PurgeService {
  return new PurgeService(db, logger);
}

/** Runs the outbox until nothing is due, and returns every captured message. */
export async function runOutbox(email: MemoryCaptureEmailAdapter): Promise<void> {
  await buildOutboxProcessor(email).tick(new AbortController().signal);
}

/** The six-digit code inside a captured email. */
export function codeFromEmail(text: string): string {
  const match = /\b([0-9]{6})\b/.exec(text);
  if (!match?.[1]) {
    throw new Error("the captured email carries no six-digit code");
  }
  return match[1];
}

export function uuid(): string {
  return crypto.randomUUID();
}

/** Moves a refresh token into the past, honouring `chk_refresh_tokens_expiry` (expires_at > created_at). */
export async function expireRefreshToken(id: number): Promise<void> {
  await db("refresh_tokens")
    .where("id", id)
    .update({
      created_at: db.raw("now() - interval '31 days'"),
      expires_at: db.raw("now() - interval '1 day'"),
    });
}
