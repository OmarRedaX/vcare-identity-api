import type { LoopHandle, LoopOptions } from "./types";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * The worker's poll loop (ADR 0007). Ticks never overlap; a failing tick is logged and the loop continues;
 * stop() lets the current tick finish and never starts another.
 */
export function runLoop(options: LoopOptions): LoopHandle {
  const controller = new AbortController();
  const { signal } = controller;

  const stopped = (async () => {
    while (!signal.aborted) {
      try {
        await options.tick(signal);
      } catch (err) {
        options.logger.error("worker_tick_failed", { loop: options.name, err });
      }
      if (signal.aborted) {
        break;
      }
      await sleep(options.intervalMs, signal);
    }
  })();

  let stopping: Promise<void> | undefined;

  return {
    stopped,
    stop(): Promise<void> {
      stopping ??= (async () => {
        controller.abort();
        await stopped;
      })();
      return stopping;
    },
  };
}
