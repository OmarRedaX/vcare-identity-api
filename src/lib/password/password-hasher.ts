import argon2 from "argon2";
import bcrypt from "bcrypt";
import { randomToken } from "../../pkg/utils/crypto";
import type { Logger } from "../logger/logger";
import { HashQueueFull, Semaphore } from "./semaphore";
import type { Argon2Parameters, PasswordVerification } from "./types";

/** ADR 0003. Tune upward, never down. */
export const ARGON2_PARAMETERS: Argon2Parameters = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
};

const BCRYPT_PREFIXES = ["$2a$", "$2b$", "$2y$"];
const ARGON2ID_PREFIX = "$argon2id$";
const QUEUE_DEPTH_METRIC_INTERVAL_MS = 10_000;

/**
 * argon2id hashing behind a bounded semaphore (CLAUDE.md -> Security rules). bcrypt is **verify only**
 * (ADR 0016); nothing in this service creates a bcrypt hash. Inputs and hashes are never logged and never
 * compared with `===`.
 */
export class PasswordHasher {
  private readonly semaphore: Semaphore;
  private readonly logger: Logger;
  private dummyHash: string | undefined;
  private lastQueueDepthMetricAt = 0;

  constructor(semaphore: Semaphore, logger: Logger) {
    this.semaphore = semaphore;
    this.logger = logger;
  }

  hash(plain: string): Promise<string> {
    return this.guard(() => argon2.hash(plain, { type: argon2.argon2id, ...ARGON2_PARAMETERS }));
  }

  async verify(stored: string, plain: string): Promise<PasswordVerification> {
    return this.guard(async () => {
      if (stored.startsWith(ARGON2ID_PREFIX)) {
        const ok = await argon2.verify(stored, plain).catch(() => false);
        return { ok, needsRehash: ok && argon2.needsRehash(stored, ARGON2_PARAMETERS) };
      }

      if (BCRYPT_PREFIXES.some((prefix) => stored.startsWith(prefix))) {
        const ok = await bcrypt.compare(plain, stored).catch(() => false);
        // A legacy hash is always rewritten with argon2id after a successful login (BR-10).
        return { ok, needsRehash: ok };
      }

      this.logger.warn("password_hash_unrecognized");
      return { ok: false, needsRehash: false };
    });
  }

  /**
   * Equalizes the cost of an unknown email with a wrong password (CLAUDE.md -> Security rules).
   * The dummy hash is computed once, from a discarded random value; the result is deliberately ignored.
   */
  async verifyDummy(plain: string): Promise<void> {
    await this.guard(async () => {
      this.dummyHash ??= await argon2.hash(randomToken(32), {
        type: argon2.argon2id,
        ...ARGON2_PARAMETERS,
      });
      await argon2.verify(this.dummyHash, plain).catch(() => false);
    });
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    this.reportQueueDepth();
    try {
      return await this.semaphore.run(fn);
    } catch (err) {
      if (err === HashQueueFull) {
        this.logger.metric("hash_rejected", 1, "Count");
      }
      throw err;
    }
  }

  private reportQueueDepth(): void {
    const depth = this.semaphore.queueDepth();
    if (depth === 0) {
      return;
    }
    const now = Date.now();
    if (now - this.lastQueueDepthMetricAt < QUEUE_DEPTH_METRIC_INTERVAL_MS) {
      return;
    }
    this.lastQueueDepthMetricAt = now;
    this.logger.metric("hash_queue_depth", depth, "Count");
  }
}
