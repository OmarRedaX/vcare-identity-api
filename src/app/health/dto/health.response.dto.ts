import type { DependencyState, HealthState } from "../enums";
import type { LivenessBody, ReadinessBody } from "../types";

/** Bare bodies (not enveloped) — contracts/openapi.yaml HealthLive / HealthStatus. */
export class LivenessResponseDto {
  status!: HealthState.Ok;

  static from(body: LivenessBody): LivenessResponseDto {
    const dto = new LivenessResponseDto();
    dto.status = body.status;
    return dto;
  }
}

export class ReadinessResponseDto {
  status!: HealthState;
  checks!: { database: DependencyState; redis: DependencyState };

  static from(body: ReadinessBody): ReadinessResponseDto {
    const dto = new ReadinessResponseDto();
    dto.status = body.status;
    dto.checks = { database: body.checks.database, redis: body.checks.redis };
    return dto;
  }
}
