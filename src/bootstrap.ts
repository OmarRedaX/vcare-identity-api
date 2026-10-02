import type { DependencyContainer } from "tsyringe";
import { AuthController } from "./app/auth/controller/auth.controller";
import { JwksController } from "./app/auth/controller/jwks.controller";
import { AccountService } from "./app/auth/service/account.service";
import { AuthMailService } from "./app/auth/service/auth-mail.service";
import { PasswordService } from "./app/auth/service/password.service";
import { PurgeService } from "./app/auth/service/purge.service";
import { RegistrationService } from "./app/auth/service/registration.service";
import { SessionService } from "./app/auth/service/session.service";
import { HealthController } from "./app/health/controller/health.controller";
import { HealthService } from "./app/health/service/health.service";
import { loadSigningKeys } from "./lib/auth/keys";
import { TokenSigner } from "./lib/auth/jwt";
import type { SigningKeySet } from "./lib/auth/types";
import { env } from "./lib/config/env";
import { requireEmailConfig } from "./lib/config/requirements";
import { container as rootContainer } from "./lib/di/container";
import { TOKENS } from "./lib/di/tokens";
import { FileCaptureEmailAdapter } from "./lib/email/file-capture-adapter";
import { ResendEmailAdapter } from "./lib/email/resend-adapter";
import type { EmailPort } from "./lib/email/types";
import { db } from "./lib/knex/knex";
import { lifecycle } from "./lib/lifecycle/lifecycle";
import { logger } from "./lib/logger/logger";
import { PasswordHasher } from "./lib/password/password-hasher";
import { Semaphore } from "./lib/password/semaphore";
import { redis } from "./lib/redis/redis";
import { systemClock } from "./lib/time/clock";
import type { Clock } from "./lib/time/types";
import type { DependencyOverrides } from "./types";

let rootRegistered = false;

/** `EMAIL_PROVIDER=capture` is refused in production by env validation (spec §5.7). */
function buildEmailPort(): EmailPort {
  const config = requireEmailConfig(env);
  return config.kind === "capture"
    ? new FileCaptureEmailAdapter(config)
    : new ResendEmailAdapter(config);
}

/**
 * The only place that wires lib/ singletons and app/ classes into the container
 * (CLAUDE.md -> Folder structure and layering). Idempotent for the root container.
 *
 * The signing key set and the email port are built **lazily on first resolve**, so the worker never parses
 * signing keys and the API never needs the email provider's API key.
 */
export function registerDependencies(overrides?: DependencyOverrides): DependencyContainer {
  const hasOverrides = overrides !== undefined && Object.keys(overrides).length > 0;
  const scope = hasOverrides ? rootContainer.createChildContainer() : rootContainer;

  if (!hasOverrides && rootRegistered) {
    return scope;
  }

  scope.registerInstance(TOKENS.Env, env);
  scope.registerInstance(TOKENS.Logger, overrides?.logger ?? logger);
  scope.registerInstance(TOKENS.Db, overrides?.db ?? db);
  scope.registerInstance(TOKENS.Redis, overrides?.redis ?? redis);
  scope.registerInstance(TOKENS.Lifecycle, overrides?.lifecycle ?? lifecycle);

  const clock: Clock = overrides?.clock ?? systemClock;
  scope.registerInstance(TOKENS.Clock, clock);

  let signingKeys: SigningKeySet | undefined = overrides?.signingKeys;
  scope.register<SigningKeySet>(TOKENS.SigningKeys, {
    useFactory: () => (signingKeys ??= loadSigningKeys(env)),
  });

  let emailPort: EmailPort | undefined = overrides?.emailPort;
  scope.register<EmailPort>(TOKENS.EmailPort, {
    useFactory: () => (emailPort ??= buildEmailPort()),
  });

  scope.registerInstance(
    TOKENS.PasswordHasher,
    new PasswordHasher(
      new Semaphore(env.HASH_CONCURRENCY, env.HASH_QUEUE_MAX),
      overrides?.logger ?? logger,
    ),
  );

  scope.register<TokenSigner>(TOKENS.TokenSigner, {
    useFactory: (container) => new TokenSigner(container.resolve(TOKENS.SigningKeys), clock),
  });

  scope.registerSingleton(TOKENS.HealthService, HealthService);
  scope.registerSingleton(TOKENS.HealthController, HealthController);

  scope.registerSingleton(TOKENS.RegistrationService, RegistrationService);
  scope.registerSingleton(TOKENS.SessionService, SessionService);
  scope.registerSingleton(TOKENS.PasswordService, PasswordService);
  scope.registerSingleton(TOKENS.AccountService, AccountService);
  scope.registerSingleton(TOKENS.AuthMailService, AuthMailService);
  scope.registerSingleton(TOKENS.PurgeService, PurgeService);
  scope.registerSingleton(TOKENS.AuthController, AuthController);
  scope.registerSingleton(TOKENS.JwksController, JwksController);

  if (!hasOverrides) {
    rootRegistered = true;
  }

  return scope;
}
