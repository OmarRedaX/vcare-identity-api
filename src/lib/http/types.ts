export interface SuccessBody<T> {
  success: true;
  data: T;
  meta?: Record<string, unknown>;
}

export interface CorsOptions {
  origins: readonly string[];
}
