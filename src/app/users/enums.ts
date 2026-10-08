/** Who initiates a status change: an admin through `/api/users`, or a service through `/internal/users` (D-1). */
export enum StatusCaller {
  Admin = "admin",
  Service = "service",
}
