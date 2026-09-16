import { env } from "../config/env";
import { getRequestContext } from "../request-id/context";
import { redact } from "./redact";
import type { LogFields, LoggerOptions, LogLevel, MetricUnit } from "./types";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const RESERVED_KEYS = new Set(["level", "message", "timestamp", "service"]);
const METRIC_NAMESPACE = "vcare/identity-service";

/** One structured JSON line per event (CLAUDE.md -> Privacy and logging). The logger never throws. */
export class Logger {
  private readonly service: string;
  private readonly production: boolean;
  private readonly sink: (line: string) => void;
  private level: LogLevel;

  constructor(options: LoggerOptions) {
    this.service = options.service;
    this.level = options.level;
    this.production = options.production;
    this.sink = options.sink ?? ((line: string) => process.stdout.write(line));
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, fields?: LogFields): void {
    this.write("debug", message, fields);
  }

  info(message: string, fields?: LogFields): void {
    this.write("info", message, fields);
  }

  warn(message: string, fields?: LogFields): void {
    this.write("warn", message, fields);
  }

  error(message: string, fields?: LogFields): void {
    this.write("error", message, fields);
  }

  /** Embedded-metric-format line (ADR 0013). Never suppressed by LOG_LEVEL. */
  metric(name: string, value: number, unit: MetricUnit, dimensions?: Record<string, string>): void {
    const dimensionKeys = Object.keys(dimensions ?? {});
    const line: Record<string, unknown> = {
      level: "info",
      message: "metric",
      timestamp: new Date().toISOString(),
      service: this.service,
      ...this.contextFields(),
      _aws: {
        Timestamp: Date.now(),
        CloudWatchMetrics: [
          {
            Namespace: METRIC_NAMESPACE,
            Dimensions: dimensionKeys.length > 0 ? [dimensionKeys] : [],
            Metrics: [{ Name: name, Unit: unit }],
          },
        ],
      },
      [name]: value,
      ...(redact(dimensions ?? {}, false) as Record<string, unknown>),
    };
    this.emit(line);
  }

  private contextFields(): Record<string, unknown> {
    const context = getRequestContext();
    if (!context) {
      return {};
    }
    const fields: Record<string, unknown> = { requestId: context.requestId };
    if (context.userId !== undefined) {
      fields.userId = context.userId;
    }
    if (context.clientId !== undefined) {
      fields.clientId = context.clientId;
    }
    return fields;
  }

  private write(level: LogLevel, message: string, fields?: LogFields): void {
    if (level === "debug" && this.production) {
      return;
    }
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) {
      return;
    }

    const safeFields = redact(fields ?? {}, level === "error") as Record<string, unknown>;
    for (const key of Object.keys(safeFields)) {
      if (RESERVED_KEYS.has(key)) {
        delete safeFields[key];
      }
    }

    this.emit({
      level,
      message,
      timestamp: new Date().toISOString(),
      service: this.service,
      ...this.contextFields(),
      ...safeFields,
    });
  }

  private emit(line: Record<string, unknown>): void {
    try {
      this.sink(`${JSON.stringify(line)}\n`);
    } catch {
      this.sink(
        `${JSON.stringify({
          level: "error",
          message: "log_serialization_failed",
          timestamp: new Date().toISOString(),
          service: this.service,
        })}\n`,
      );
    }
  }
}

export const logger = new Logger({
  service: "identity-service",
  level: env.LOG_LEVEL,
  production: env.NODE_ENV === "production",
  sink: (line: string) => {
    process.stdout.write(line);
  },
});
