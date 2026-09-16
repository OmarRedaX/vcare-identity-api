/**
 * Atomic sliding-window log on the Redis clock (CLAUDE.md -> Security rules).
 * KEYS[1] = rl:<name>:<subject> · ARGV = limit, windowMs, unique member suffix.
 * Returns { allowed (1|0), retryAfterSeconds }. Rejected attempts are not recorded.
 */
export const SLIDING_WINDOW_SCRIPT = `
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local member = ARGV[3]

local time = redis.call('TIME')
local now_ms = (tonumber(time[1]) * 1000) + math.floor(tonumber(time[2]) / 1000)

redis.call('ZREMRANGEBYSCORE', key, 0, now_ms - window)
local count = redis.call('ZCARD', key)

if count < limit then
  redis.call('ZADD', key, now_ms, now_ms .. '-' .. member)
  redis.call('PEXPIRE', key, window)
  return {1, 0}
end

local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
local retry = 1
if oldest[2] then
  retry = math.ceil((tonumber(oldest[2]) + window - now_ms) / 1000)
  if retry < 1 then retry = 1 end
end
return {0, retry}
`;
