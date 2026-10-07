/**
 * The module introduces no new error code (spec section 7). The two instances it throws are re-exported so
 * the service imports its errors from one place; only `errorHandler` renders them.
 */
export { InvalidCredentials } from "../auth/errors";
export { InsufficientScope } from "../../lib/error/errors";
