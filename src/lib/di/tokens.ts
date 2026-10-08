/** DI tokens (CLAUDE.md -> Tech stack: tsyringe with Symbol.for() tokens). */
export const TOKENS = {
  Env: Symbol.for("Env"),
  Logger: Symbol.for("Logger"),
  Db: Symbol.for("Db"),
  ProbeDb: Symbol.for("ProbeDb"),
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

  // ── users ──
  UsersService: Symbol.for("UsersService"),
  UsersController: Symbol.for("UsersController"),

  // -- internal-users --
  InternalUsersService: Symbol.for("InternalUsersService"),
  InternalUsersController: Symbol.for("InternalUsersController"),

  // -- service-auth --
  ServiceAuthService: Symbol.for("ServiceAuthService"),
  ServiceAuthController: Symbol.for("ServiceAuthController"),
} as const;
