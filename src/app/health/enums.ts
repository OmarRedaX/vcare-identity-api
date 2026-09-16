/** Values match contracts/openapi.yaml -> HealthLive / HealthStatus. */
export enum HealthState {
  Ok = "ok",
  Degraded = "degraded",
  Down = "down",
}

export enum DependencyState {
  Up = "up",
  Down = "down",
}
