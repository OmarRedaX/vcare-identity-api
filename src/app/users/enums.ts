/** Who initiates a status change; `service` is wired by Epic B (`internal-users`), not by this unit (D-1). */
export enum StatusCaller {
  Admin = "admin",
  Service = "service",
}
