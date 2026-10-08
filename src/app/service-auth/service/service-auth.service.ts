import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import type { TokenSigner } from "../../../lib/auth/jwt";
import { TOKENS } from "../../../lib/di/tokens";
import type { Logger } from "../../../lib/logger/logger";
import type { PasswordHasher } from "../../../lib/password/password-hasher";
import type { Clock } from "../../../lib/time/types";
import { isPast } from "../../../pkg/utils/time";
import type { ServiceClient } from "../entity/service-client.entity";
import { TokenDenialReason } from "../enums";
import { InsufficientScope, InvalidCredentials } from "../errors";
import * as serviceClients from "../repository/service-client.repo";
import type { IssueTokenCommand, IssueTokenResult } from "../types";

/** Splits on single spaces (the DTO pattern guarantees the shape), de-duplicating in first-seen order. */
function normalizeScopes(scope: string): string[] {
  return [...new Set(scope.split(" ").filter((entry) => entry.length > 0))];
}

/**
 * The client-credentials grant (spec section 3.3): one indexed read, one argon2id verify, no transaction and
 * no write on the request path. Unknown, disabled, soft-deleted and wrong-secret are indistinguishable
 * (`InvalidCredentials`, one verify each); scope and audience are judged only after the secret verified.
 */
@injectable()
export class ServiceAuthService {
  constructor(
    @inject(TOKENS.Db) private readonly db: Knex,
    @inject(TOKENS.Logger) private readonly logger: Logger,
    @inject(TOKENS.Clock) private readonly clock: Clock,
    @inject(TOKENS.PasswordHasher) private readonly hasher: PasswordHasher,
    @inject(TOKENS.TokenSigner) private readonly signer: TokenSigner,
  ) {}

  async issueToken(command: IssueTokenCommand): Promise<IssueTokenResult> {
    const scopes = normalizeScopes(command.scope);
    const client = await serviceClients.findLiveByClientId(command.clientId, this.db);

    if (client === undefined || !client.isActive) {
      // Same cost as a real verify, so the response time does not reveal which case it was (BR-1).
      await this.hasher.verifyDummy(command.clientSecret);
      this.deny(
        client === undefined ? TokenDenialReason.UnknownClient : TokenDenialReason.Inactive,
        command.clientId,
      );
      throw InvalidCredentials;
    }

    const failure = await this.verifySecret(client, command.clientSecret);
    if (failure !== undefined) {
      this.deny(failure, client.clientId);
      throw InvalidCredentials;
    }

    if (!scopes.every((scope) => client.allowedScopes.includes(scope))) {
      this.deny(TokenDenialReason.Scope, client.clientId);
      throw InsufficientScope;
    }
    if (!client.allowedAudiences.includes(command.audience)) {
      this.deny(TokenDenialReason.Audience, client.clientId);
      throw InsufficientScope;
    }

    const accessToken = await this.signer.signServiceToken({
      clientId: client.clientId,
      audience: command.audience,
      scopes,
    });
    const scope = scopes.join(" ");

    this.touchLastUsed(client);
    this.logger.info("service_token_issued", {
      clientId: client.clientId,
      audience: command.audience,
      scope,
    });
    return { accessToken, scope };
  }

  /**
   * The current secret, then (only inside an unexpired rotation window) the previous one. `needsRehash` is
   * ignored on purpose: the hash is argon2id by CHECK, and ops re-hashes through rotation (D-10).
   * Returns the denial reason, or `undefined` when the secret is valid.
   */
  private async verifySecret(
    client: ServiceClient,
    secret: string,
  ): Promise<TokenDenialReason | undefined> {
    const current = await this.hasher.verify(client.clientSecretHash, secret);
    if (current.ok) {
      return undefined;
    }

    if (client.previousSecretHash === null || client.previousSecretExpiresAt === null) {
      return TokenDenialReason.BadSecret;
    }
    if (isPast(client.previousSecretExpiresAt, this.clock.now())) {
      return TokenDenialReason.SecretExpired;
    }

    const previous = await this.hasher.verify(client.previousSecretHash, secret);
    return previous.ok ? undefined : TokenDenialReason.BadSecret;
  }

  /** Fire-and-forget (D-11): a failure is logged and swallowed, and never delays the response. */
  private touchLastUsed(client: ServiceClient): void {
    serviceClients.touchLastUsed(client.id, this.clock.now(), this.db).catch(() => {
      this.logger.warn("service_client_touch_failed", { clientId: client.clientId });
    });
  }

  /** `clientId` here always matches the client-id pattern (the DTO validated it); the secret never reaches a log. */
  private deny(reason: TokenDenialReason, clientId: string): void {
    this.logger.warn("service_token_denied", { clientId, reason });
    this.logger.metric("service_token_denied", 1, "Count", { reason });
  }
}
