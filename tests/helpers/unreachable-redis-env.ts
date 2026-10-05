/**
 * Side-effect module: import it FIRST in a suite that needs the whole process to see Redis as down. The
 * route-level limiters use the process-wide Redis client, which reads REDIS_URL when `lib/config/env` loads,
 * so the variable must change before any application module is imported. Postgres stays real.
 */
process.env.REDIS_URL = "redis://127.0.0.1:1";
