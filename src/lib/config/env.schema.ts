import os from "node:os";
import { z } from "zod";

/**
 * Every environment variable the service reads is declared here (CLAUDE.md -> Security rules).
 * Secrets never carry a default. Later modules append their own variables to this schema.
 *
 * Variables that only one process needs are **optional here** and made mandatory per process by
 * `lib/config/requirements.ts` (`requireApiConfig` / `requireWorkerConfig`), so the API never holds the
 * email API key, the worker never holds signing keys, and the migration CLI needs neither (spec §5.7).
 */
const port = z.coerce.number().int().min(1).max(65535);

const BASE64URL_32_BYTES = /^[A-Za-z0-9_-]{43}$/;

/** One Ed25519 signing key: the private half never leaves JWT_PRIVATE_KEYS (ADR 0002). */
const signingKeyEntry = z.strictObject({
  kid: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/),
  privateJwk: z.strictObject({
    kty: z.literal("OKP"),
    crv: z.literal("Ed25519"),
    d: z.string().regex(BASE64URL_32_BYTES),
    x: z.string().regex(BASE64URL_32_BYTES),
  }),
});

const signingKeySet = z
  .array(signingKeyEntry)
  .min(1)
  .refine((keys) => new Set(keys.map((key) => key.kid)).size === keys.length, {
    message: "must not repeat a kid",
  });

/** SECRET. The message never echoes the value, so a bad key cannot leak through the boot log. */
const jwtPrivateKeys = z
  .string()
  .transform((value, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a JSON array of signing keys" });
      return z.NEVER;
    }
    const result = signingKeySet.safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        message: "must be a JSON array of { kid, privateJwk: { kty, crv, d, x } } with unique kids",
      });
      return z.NEVER;
    }
    return result.data;
  })
  .optional();

const baseUrl = z
  .url({ protocol: /^https?$/ })
  .refine((value) => !value.endsWith("/"), { message: "must not end with a slash" });

const corsOrigins = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined
      ? []
      : value
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
  )
  .superRefine((origins, ctx) => {
    for (const origin of origins) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        ctx.addIssue({ code: "custom", message: "must be a list of origins" });
        return;
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        ctx.addIssue({ code: "custom", message: "must use http or https" });
        return;
      }
      if (parsed.origin !== origin) {
        ctx.addIssue({ code: "custom", message: "must be a bare origin without a path" });
        return;
      }
    }
  });

export const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: port.default(3000),
    INTERNAL_PORT: port.default(3100),
    INTERNAL_HOST: z.union([z.ipv4(), z.ipv6()]).default("127.0.0.1"),
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    CORS_ORIGINS: corsOrigins,
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(10000),
    RATE_LIMIT_FALLBACK_DIVISOR: z.coerce.number().int().min(1).default(2),
    WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).max(60000).default(1000),

    // ── auth: tokens and one-time secrets (API) ──
    JWT_PRIVATE_KEYS: jwtPrivateKeys,
    JWT_ACTIVE_KID: z.string().regex(/^[A-Za-z0-9._-]{1,64}$/).optional(),
    OTP_PEPPER: z.string().min(32).optional(),
    REFRESH_REUSE_GRACE_SECONDS: z.coerce.number().int().min(0).max(30).default(10),
    HASH_CONCURRENCY: z.coerce
      .number()
      .int()
      .min(1)
      .max(32)
      .default(Math.min(4, os.availableParallelism())),
    HASH_QUEUE_MAX: z.coerce.number().int().min(0).max(1000).default(50),

    // ── auth: worker (outbox delivery and purges) ──
    WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(8),
    APP_BASE_URL: baseUrl.optional(),
    EMAIL_PROVIDER: z.enum(["resend", "capture"]).optional(),
    EMAIL_PROVIDER_API_KEY: z.string().min(1).optional(),
    EMAIL_PROVIDER_FROM: z.email().optional(),
    EMAIL_PROVIDER_BASE_URL: z.url({ protocol: /^https?$/ }).default("https://api.resend.com"),
    EMAIL_CAPTURE_DIR: z.string().min(1).default(".local/mail"),
  })
  .superRefine((value, ctx) => {
    if (value.JWT_ACTIVE_KID !== undefined && value.JWT_PRIVATE_KEYS !== undefined) {
      if (!value.JWT_PRIVATE_KEYS.some((key) => key.kid === value.JWT_ACTIVE_KID)) {
        ctx.addIssue({
          code: "custom",
          path: ["JWT_ACTIVE_KID"],
          message: "must name a kid present in JWT_PRIVATE_KEYS",
        });
      }
    }
    if (value.EMAIL_PROVIDER === "capture" && value.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_PROVIDER"],
        message: "must not be capture in production",
      });
    }
    if (value.NODE_ENV === "production" && !value.EMAIL_PROVIDER_BASE_URL.startsWith("https://")) {
      ctx.addIssue({
        code: "custom",
        path: ["EMAIL_PROVIDER_BASE_URL"],
        message: "must use https in production",
      });
    }
    if (value.INTERNAL_PORT === value.PORT) {
      ctx.addIssue({
        code: "custom",
        path: ["INTERNAL_PORT"],
        message: "must differ from PORT",
      });
    }
    if (value.LOG_LEVEL === "debug" && value.NODE_ENV === "production") {
      ctx.addIssue({
        code: "custom",
        path: ["LOG_LEVEL"],
        message: "must not be debug in production",
      });
    }
  });
