import type Redis from "ioredis";
import type { Knex } from "knex";
import { inject, injectable } from "tsyringe";
import { TOKENS } from "../../../lib/di/tokens";
import type { Lifecycle } from "../../../lib/lifecycle/lifecycle";
import type { Logger } from "../../../lib/logger/logger";
import { pingRedis } from "../../../lib/redis/redis";
import { pingDatabase } from "../repository/health.repo";
import { DependencyState, HealthState } from "../enums";
import type { LivenessBody, ReadinessResult } from "../types";

const CHECK_TIMEOUT_MS = 500;

/** ADR 0014: Postgres is fatal for readiness, Redis is reported only (Redis is Tier 2, ADR 0008). */
@injectable()
export class HealthService {
  constructor(
    @inject(TOKENS.ProbeDb) private readonly db: Knex,
    @inject(TOKENS.Redis) private readonly redis: Redis,
    @inject(TOKENS.Lifecycle) private readonly lifecycle: Lifecycle,
    @inject(TOKENS.Logger) private readonly logger: Logger,
  ) {}

  liveness(): LivenessBody {
    return { status: HealthState.Ok };
  }

  async readiness(): Promise<ReadinessResult> {
    const [database, redis] = await Promise.all([
      this.checkDatabase(),
      pingRedis(this.redis, CHECK_TIMEOUT_MS).then((health) =>
        health === "up" ? DependencyState.Up : DependencyState.Down,
      ),
    ]);

    const shuttingDown = this.lifecycle.isShuttingDown();
    const down = shuttingDown || database === DependencyState.Down;
    const status = down
      ? HealthState.Down
      : redis === DependencyState.Down
        ? HealthState.Degraded
        : HealthState.Ok;

    const result: ReadinessResult = {
      httpStatus: down ? 503 : 200,
      body: { status, checks: { database, redis } },
    };

    if (down) {
      this.logger.warn("readiness_failed", { checks: result.body.checks, shuttingDown });
    }

    return result;
  }

  private async checkDatabase(): Promise<DependencyState> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        pingDatabase(this.db),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error("database_timeout"));
          }, CHECK_TIMEOUT_MS);
        }),
      ]);
      return DependencyState.Up;
    } catch {
      return DependencyState.Down;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
