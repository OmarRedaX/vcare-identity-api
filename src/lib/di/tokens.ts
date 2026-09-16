/** DI tokens (CLAUDE.md -> Tech stack: tsyringe with Symbol.for() tokens). */
export const TOKENS = {
  Env: Symbol.for("Env"),
  Logger: Symbol.for("Logger"),
  Db: Symbol.for("Db"),
  Redis: Symbol.for("Redis"),
  Lifecycle: Symbol.for("Lifecycle"),
  HealthService: Symbol.for("HealthService"),
  HealthController: Symbol.for("HealthController"),
} as const;
