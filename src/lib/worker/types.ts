import type { Logger } from "../logger/logger";

export interface LoopOptions {
  name: string;
  intervalMs: number;
  tick: (signal: AbortSignal) => Promise<void>;
  logger: Logger;
}

export interface LoopHandle {
  stop(): Promise<void>;
  readonly stopped: Promise<void>;
}
