import type { Request, Response } from "express";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import { sendRaw } from "../../../lib/http/response";
import { LivenessResponseDto, ReadinessResponseDto } from "../dto/health.response.dto";
import type { HealthService } from "../service/health.service";

@injectable()
export class HealthController {
  constructor(@inject(TOKENS.HealthService) private readonly service: HealthService) {}

  live = (_req: Request, res: Response): void => {
    res.setHeader("Cache-Control", "no-store");
    sendRaw(res, 200, LivenessResponseDto.from(this.service.liveness()));
  };

  ready = async (_req: Request, res: Response): Promise<void> => {
    res.setHeader("Cache-Control", "no-store");
    const result = await this.service.readiness();
    sendRaw(res, result.httpStatus, ReadinessResponseDto.from(result.body));
  };
}
