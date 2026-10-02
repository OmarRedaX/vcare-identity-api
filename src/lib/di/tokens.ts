/** DI tokens (CLAUDE.md -> Tech stack: tsyringe with Symbol.for() tokens). */
export const TOKENS = {
  Env: Symbol.for("Env"),
  Logger: Symbol.for("Logger"),
  Db: Symbol.for("Db"),
  Redis: Symbol.for("Redis"),
  Lifecycle: Symbol.for("Lifecycle"),
  HealthService: Symbol.for("HealthService"),
  HealthController: Symbol.for("HealthController"),

  // ── auth ──
  Clock: Symbol.for("Clock"),
  SigningKeys: Symbol.for("SigningKeys"),
  TokenSigner: Symbol.for("TokenSigner"),
  PasswordHasher: Symbol.for("PasswordHasher"),
  EmailPort: Symbol.for("EmailPort"),
  RegistrationService: Symbol.for("RegistrationService"),
  SessionService: Symbol.for("SessionService"),
  PasswordService: Symbol.for("PasswordService"),
  AccountService: Symbol.for("AccountService"),
  AuthMailService: Symbol.for("AuthMailService"),
  PurgeService: Symbol.for("PurgeService"),
  AuthController: Symbol.for("AuthController"),
  JwksController: Symbol.for("JwksController"),
} as const;
