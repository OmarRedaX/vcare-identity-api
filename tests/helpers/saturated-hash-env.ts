/**
 * Side-effect module: import it FIRST in a suite that needs a hash pool with one slot and no queue, so a second
 * concurrent argon2 verify is refused with 429 instead of waiting. The pool is sized when `lib/config/env` loads.
 */
process.env.HASH_CONCURRENCY = "1";
process.env.HASH_QUEUE_MAX = "0";
