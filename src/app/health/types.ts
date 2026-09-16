import type { DependencyState, HealthState } from "./enums";

export interface ReadinessBody {
  status: HealthState;
  checks: {
    database: DependencyState;
    redis: DependencyState;
  };
}

export interface ReadinessResult {
  httpStatus: 200 | 503;
  body: ReadinessBody;
}

export interface LivenessBody {
  status: HealthState.Ok;
}
