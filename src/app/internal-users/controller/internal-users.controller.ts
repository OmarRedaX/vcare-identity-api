import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { ServiceTokenRequired } from "../../../lib/error/errors";
import { sendSuccess } from "../../../lib/http/response";
import type { ServiceAuth } from "../../../lib/types/types";
import { validateBody, validateParams, validateQuery } from "../../../lib/validation/validate";
import { StatusChangeResponseDto } from "../../users/dto/users.response.dto";
import { UserIdParamDto } from "../../users/dto/users.request.dto";
import { StatusCaller } from "../../users/enums";
import type { UsersService } from "../../users/service/users.service";
import { IdsQueryDto, InternalStatusChangeDto } from "../dto/internal-users.request.dto";
import { UserContactResponseDto, UserSummaryResponseDto } from "../dto/internal-users.response.dto";
import type { InternalUsersService } from "../service/internal-users.service";

/** `serviceGuard` + `authorize(policy)` have already proven this, so a miss is a wiring bug, not a request. */
function requireServiceAuth(req: Request): ServiceAuth {
  const auth = req.auth;
  if (auth?.kind !== "service") {
    throw ServiceTokenRequired;
  }
  return auth;
}

/** The three `/internal/users` operations: validate -> call the service -> send. No business logic. */
@injectable()
export class InternalUsersController {
  constructor(
    @inject(TOKENS.UsersService) private readonly users: UsersService,
    @inject(TOKENS.InternalUsersService) private readonly internalUsers: InternalUsersService,
  ) {}

  updateUserStatus = async (req: Request, res: Response): Promise<void> => {
    const auth = requireServiceAuth(req);
    const params = await validateParams(UserIdParamDto, req.params);
    const dto = await validateBody(InternalStatusChangeDto, req.body);

    const result = await this.users.applyStatusChange({
      targetId: params.id,
      toStatus: dto.status,
      reason: dto.reason,
      caller: { kind: StatusCaller.Service, actorService: auth.clientId, actorUserId: dto.actorUserId },
      requestId: req.requestId,
    });
    sendSuccess(res, StatusChangeResponseDto.from(result));
  };

  batchGetUsers = async (req: Request, res: Response): Promise<void> => {
    const auth = requireServiceAuth(req);
    const query = await validateQuery(IdsQueryDto, req.query);

    const summaries = await this.internalUsers.getSummaries(query.ids, auth.clientId);
    sendSuccess(
      res,
      summaries.map((summary) => UserSummaryResponseDto.from(summary)),
    );
  };

  getContacts = async (req: Request, res: Response): Promise<void> => {
    const auth = requireServiceAuth(req);
    const query = await validateQuery(IdsQueryDto, req.query);

    const contacts = await this.internalUsers.getContacts(query.ids, auth.clientId);
    sendSuccess(
      res,
      contacts.map((contact) => UserContactResponseDto.from(contact)),
    );
  };
}
