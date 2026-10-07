import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { sendSuccess } from "../../../lib/http/response";
import { getRequestContext } from "../../../lib/request-id/context";
import { validateBody } from "../../../lib/validation/validate";
import { ServiceTokenRequestDto } from "../dto/service-auth.request.dto";
import { ServiceTokenResponseDto } from "../dto/service-auth.response.dto";
import type { ServiceAuthService } from "../service/service-auth.service";

/** `POST /internal/auth/token`: validate -> call the service -> send. No business logic. */
@injectable()
export class ServiceAuthController {
  constructor(@inject(TOKENS.ServiceAuthService) private readonly serviceAuth: ServiceAuthService) {}

  issueToken = async (req: Request, res: Response): Promise<void> => {
    const dto = await validateBody(ServiceTokenRequestDto, req.body);

    // Validated against the client-id pattern, so it is safe to put on every log line of this request.
    const context = getRequestContext();
    if (context) {
      context.clientId = dto.client_id;
    }

    const result = await this.serviceAuth.issueToken({
      clientId: dto.client_id,
      clientSecret: dto.client_secret,
      scope: dto.scope,
      audience: dto.audience,
    });
    sendSuccess(res, ServiceTokenResponseDto.from(result));
  };
}
