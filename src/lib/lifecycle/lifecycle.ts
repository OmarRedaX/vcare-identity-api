/** Shutdown and in-flight state shared by server.ts, worker.ts and HealthService (spec §4.18). */
export class Lifecycle {
  private shuttingDown = false;
  private inflight = 0;

  markShuttingDown(): void {
    this.shuttingDown = true;
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  requestStarted(): void {
    this.inflight += 1;
  }

  requestEnded(): void {
    this.inflight = Math.max(0, this.inflight - 1);
  }

  inflightCount(): number {
    return this.inflight;
  }
}

export const lifecycle = new Lifecycle();
