export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogFields = Record<string, unknown>;

export type MetricUnit = "Count" | "Milliseconds" | "Seconds";

export interface LoggerOptions {
  service: string;
  level: LogLevel;
  production: boolean;
  sink?: (line: string) => void;
}
