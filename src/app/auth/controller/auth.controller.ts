import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { clearRefreshCookie, readRefreshCookie, setRefreshCookie } from "../../../lib/http/cookies";
import { sendAccepted, sendNoContent, sendSuccess } from "../../../lib/http/response";
import { AccountSuspended, RateLimited, Unauthorized } from "../../../lib/error/errors";
import { TOKENS } from "../../../lib/di/tokens";
import type { UserAuth } from "../../../lib/types/types";
import { validateBody } from "../../../lib/validation/validate";
import {
  AccessTokenResponseDto,
  LoginResponseDto,
  UserResponseDto,
} from "../dto/auth.response.dto";
import {
  ChangePasswordRequestDto,
  ForgotPasswordRequestDto,
  LoginRequestDto,
  RegisterCompleteRequestDto,
  RegisterStartRequestDto,
  ResetPasswordRequestDto,
  UpdateMeRequestDto,
} from "../dto/auth.request.dto";
import { RefreshTokenInvalid, RefreshTokenReused } from "../errors";
import type { AccountService } from "../service/account.service";
import type { PasswordService } from "../service/password.service";
import type { RegistrationService } from "../service/registration.service";
import type { SessionService } from "../service/session.service";
import type { UpdateProfileInput } from "../types";

/** `authorize(selfPolicy)` has already proven this, so a miss here is a wiring bug, not a request. */
function requireUserAuth(req: Request): UserAuth {
  const auth = req.auth;
  if (auth?.kind !== "user") {
    throw Unauthorized;
  }
  return auth;
}

function userAgentOf(req: Request): string | undefined {
  const header = req.headers["user-agent"];
  return typeof header === "string" ? header : undefined;
}

/**
 * The ten `/api/auth` operations: validate -> call the service -> send (CLAUDE.md -> Module file
 * conventions, item 6). No business logic; cookies are written here from the service's result, and the
 * refresh token never appears in a body.
 */
@injectable()
export class AuthController {
  constructor(
    @inject(TOKENS.RegistrationService) private readonly registration: RegistrationService,
    @inject(TOKENS.SessionService) private readonly sessions: SessionService,
    @inject(TOKENS.PasswordService) private readonly passwords: PasswordService,
    @inject(TOKENS.AccountService) private readonly accounts: AccountService,
  ) {}

  startRegistration = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateBody(RegisterStartRequestDto, req.body);
    await this.registration.start(dto.email, req.requestId);
    // Identical for a known and an unknown email (BR-1).
    sendAccepted(res);
  };

  completeRegistration = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateBody(RegisterCompleteRequestDto, req.body);
    const user = await this.registration.complete({
      email: dto.email,
      code: dto.code,
      password: dto.password,
      fullName: dto.fullName,
      role: dto.role,
      phone: dto.phone,
      timezone: dto.timezone,
      locale: dto.locale,
    });
    // The account is created but not logged in: no token, no cookie.
    sendSuccess(res, UserResponseDto.from(user), 201);
  };

  login = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateBody(LoginRequestDto, req.body);
    const result = await this.sessions.login({
      email: dto.email,
      password: dto.password,
      userAgent: userAgentOf(req),
    });
    setRefreshCookie(res, result.refreshToken);
    sendSuccess(res, LoginResponseDto.from(result.accessToken, result.user));
  };

  refresh = async (req: Request, res: Response): Promise<void> => {
    const outcome = await this.sessions.refresh(readRefreshCookie(req));

    switch (outcome.kind) {
      case "rotated":
        setRefreshCookie(res, outcome.refreshToken);
        sendSuccess(res, AccessTokenResponseDto.from(outcome.accessToken));
        return;
      case "grace":
        // Inside the grace window the shared cookie jar already holds the successor: do not clear it
        // and do not revoke the family (ADR 0005).
        throw RefreshTokenInvalid;
      case "reused":
        clearRefreshCookie(res);
        throw RefreshTokenReused;
      case "suspended":
        clearRefreshCookie(res);
        throw AccountSuspended;
      case "rate_limited":
        // The cookie is untouched: the client may retry with the same token.
        throw RateLimited.withRetryAfter(outcome.retryAfterSeconds);
      default:
        clearRefreshCookie(res);
        throw RefreshTokenInvalid;
    }
  };

  logout = async (req: Request, res: Response): Promise<void> => {
    await this.sessions.logout(readRefreshCookie(req));
    // Always 204 with a clearing cookie, so clients can call it unconditionally (BR-17).
    clearRefreshCookie(res);
    sendNoContent(res);
  };

  forgotPassword = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateBody(ForgotPasswordRequestDto, req.body);
    await this.passwords.forgot(dto.email, req.requestId);
    // Always 204, whether or not the email exists (BR-18).
    sendNoContent(res);
  };

  resetPassword = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateBody(ResetPasswordRequestDto, req.body);
    await this.passwords.reset({ email: dto.email, code: dto.code, newPassword: dto.newPassword });
    sendNoContent(res);
  };

  changePassword = async (req: Request, res: Response): Promise<void> => {
    const auth = requireUserAuth(req);
    const dto = await validateBody(ChangePasswordRequestDto, req.body);
    await this.passwords.change({
      userId: auth.userId,
      currentPassword: dto.currentPassword,
      newPassword: dto.newPassword,
      presentedRefreshToken: readRefreshCookie(req),
    });
    // The caller's own cookie is deliberately left in place (BR-21).
    sendNoContent(res);
  };

  getMe = async (req: Request, res: Response): Promise<void> => {
    const auth = requireUserAuth(req);
    const user = await this.accounts.getMe(auth.userId);
    sendSuccess(res, UserResponseDto.from(user));
  };

  updateMe = async (req: Request, res: Response): Promise<void> => {
    const auth = requireUserAuth(req);
    const dto = await validateBody(UpdateMeRequestDto, req.body);

    const patch: UpdateProfileInput = {};
    if (dto.fullName !== undefined) {
      patch.fullName = dto.fullName;
    }
    if (dto.phone !== undefined) {
      patch.phone = dto.phone;
    }
    if (dto.avatarUrl !== undefined) {
      patch.avatarUrl = dto.avatarUrl;
    }
    if (dto.timezone !== undefined) {
      patch.timezone = dto.timezone;
    }
    if (dto.locale !== undefined) {
      patch.locale = dto.locale;
    }

    const user = await this.accounts.updateMe(auth.userId, patch);
    sendSuccess(res, UserResponseDto.from(user));
  };
}
