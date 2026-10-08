import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { Unauthorized } from "../../../lib/error/errors";
import { decodeCursor, decodeKeyCursor } from "../../../lib/http/pagination/cursor";
import { sendNoContent, sendSuccess } from "../../../lib/http/response";
import type { UserAuth } from "../../../lib/types/types";
import { validateBody, validateParams, validateQuery } from "../../../lib/validation/validate";
import { UserResponseDto } from "../../auth/dto/auth.response.dto";
import type { LiveFamilyCursor, UserListCursor, UserListFilter } from "../../auth/types";
import { StatusCaller } from "../enums";
import {
  AdminStatusChangeDto,
  ListSessionsQueryDto,
  ListUsersQueryDto,
  UserIdParamDto,
} from "../dto/users.request.dto";
import { SessionResponseDto, StatusChangeResponseDto } from "../dto/users.response.dto";
import type { UsersService } from "../service/users.service";

/** `authorize(adminUsersPolicy)` has already proven this, so a miss here is a wiring bug, not a request. */
function requireUserAuth(req: Request): UserAuth {
  const auth = req.auth;
  if (auth?.kind !== "user") {
    throw Unauthorized;
  }
  return auth;
}

function userCursorOf(cursor: string | undefined): UserListCursor | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const decoded = decodeCursor(cursor, "iso-timestamp");
  return { createdAt: String(decoded.v), id: decoded.id };
}

function familyCursorOf(cursor: string | undefined): LiveFamilyCursor | undefined {
  if (cursor === undefined) {
    return undefined;
  }
  const decoded = decodeKeyCursor(cursor);
  return { createdAt: decoded.v, familyId: decoded.k };
}

/**
 * The five `/api/users` operations: validate -> call the service -> send (CLAUDE.md -> Module file
 * conventions, item 6). No business logic.
 */
@injectable()
export class UsersController {
  constructor(@inject(TOKENS.UsersService) private readonly users: UsersService) {}

  listUsers = async (req: Request, res: Response): Promise<void> => {
    const query = await validateQuery(ListUsersQueryDto, req.query);
    const filter: UserListFilter = {};
    if (query.role !== undefined) {
      filter.role = query.role;
    }
    if (query.status !== undefined) {
      filter.status = query.status;
    }
    if (query.email !== undefined) {
      filter.email = query.email;
    }

    const page = await this.users.listUsers(filter, userCursorOf(query.cursor), query.limit);
    sendSuccess(
      res,
      page.items.map((item) => UserResponseDto.from(item.user)),
      200,
      { ...page.meta },
    );
  };

  getUser = async (req: Request, res: Response): Promise<void> => {
    const params = await validateParams(UserIdParamDto, req.params);
    const user = await this.users.getUser(params.id);
    sendSuccess(res, UserResponseDto.from(user));
  };

  updateUserStatus = async (req: Request, res: Response): Promise<void> => {
    const auth = requireUserAuth(req);
    const params = await validateParams(UserIdParamDto, req.params);
    const dto = await validateBody(AdminStatusChangeDto, req.body);

    const result = await this.users.applyStatusChange({
      targetId: params.id,
      toStatus: dto.status,
      reason: dto.reason,
      caller: { kind: StatusCaller.Admin, actorUserId: auth.userId },
      requestId: req.requestId,
    });
    sendSuccess(res, StatusChangeResponseDto.from(result));
  };

  listUserSessions = async (req: Request, res: Response): Promise<void> => {
    const params = await validateParams(UserIdParamDto, req.params);
    const query = await validateQuery(ListSessionsQueryDto, req.query);

    const page = await this.users.listSessions(params.id, familyCursorOf(query.cursor), query.limit);
    sendSuccess(
      res,
      page.items.map((family) => SessionResponseDto.from(family)),
      200,
      { ...page.meta },
    );
  };

  revokeUserSessions = async (req: Request, res: Response): Promise<void> => {
    const auth = requireUserAuth(req);
    const params = await validateParams(UserIdParamDto, req.params);

    await this.users.revokeSessions(auth.userId, params.id);
    sendNoContent(res);
  };
}
