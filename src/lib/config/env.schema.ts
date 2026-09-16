import { z } from "zod";

/**
 * Every environment variable the service reads is declared here (CLAUDE.md -> Security rules).
 * Secrets never carry a default. Later modules append their own variables to this schema.
 */
const port = z.coerce.number().int().min(1).max(65535);

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
  })
  .superRefine((value, ctx) => {
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
