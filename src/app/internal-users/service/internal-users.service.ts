import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import type { Logger } from "../../../lib/logger/logger";
import type { UserContact } from "../../auth/types";
import type { AccountService } from "../../auth/service/account.service";

/**
 * Internal contact lookup for care-service's worker (Case 5, hub ADR 0010 / identity ADR 0024). The status route
 * needs no service of its own: it calls `UsersService.applyStatusChange`, the one transition method.
 */
@injectable()
export class InternalUsersService {
  constructor(
    @inject(TOKENS.Logger) private readonly logger: Logger,
    @inject(TOKENS.AccountService) private readonly accounts: AccountService,
  ) {}

  /** One query; unknown and soft-deleted ids are omitted. Logs counts only: never an address, name or id list. */
  async getContacts(ids: readonly number[], clientId: string): Promise<UserContact[]> {
    const unique = [...new Set(ids)];
    const contacts = await this.accounts.findContactsLive(unique);
    this.logger.info("internal_contacts_read", {
      clientId,
      requested: unique.length,
      returned: contacts.length,
    });
    return contacts;
  }
}
