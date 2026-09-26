#!/usr/bin/env bash
# Manual QA for the `foundation` module of identity-service (docs/foundation/manual-qa.md).
#
# Foundation exposes no business endpoints; this script exercises the four health probes plus the
# cross-cutting behaviour every later module inherits: error envelope, X-Request-Id, listener
# isolation, security headers, CORS, and the readiness decision table (spec §3.2, ADR 0014).
#
# Usage:
#   PUBLIC_URL=http://localhost:3020 INTERNAL_URL=http://localhost:3120 ./scripts/curl-test-foundation.sh
#   RUN_INFRA_CASES=1 ./scripts/curl-test-foundation.sh    # also stops/starts Postgres and Redis
#
# The script is read-only and idempotent unless RUN_INFRA_CASES=1, which cycles the test-stack
# containers and always restarts them before exiting.
set -euo pipefail

PUBLIC_URL="${PUBLIC_URL:-http://localhost:3020}"
INTERNAL_URL="${INTERNAL_URL:-http://localhost:3120}"
CORS_ORIGIN="${CORS_ORIGIN:-http://localhost:5173}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.test.yml}"
RUN_INFRA_CASES="${RUN_INFRA_CASES:-0}"

PASS=0
FAIL=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr "[:upper:]" "[:lower:]"
  else
    python -c "import uuid;print(uuid.uuid4())"
  fi
}

# call <method> <url> [curl args...] -> writes $TMP/body and $TMP/headers, echoes the status code
call() {
  local method="$1" url="$2"
  shift 2
  curl -s -o "$TMP/body" -D "$TMP/headers" -X "$method" \
    -H "X-Request-Id: $(uuid)" "$url" "$@" -w "%{http_code}"
}

header() { grep -i "^$1:" "$TMP/headers" | head -1 | cut -d" " -f2- | tr -d "\r"; }

# check <label> <expected> <actual>
check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    printf "  PASS  %s\n" "$label"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL  %s\n        expected: %s\n        got:      %s\n" "$label" "$expected" "$actual"
  fi
}

section() { printf "\n=== %s ===\n" "$1"; }

# ---------------------------------------------------------------------------
section "Preflight"
status="$(call GET "$PUBLIC_URL/api/health/live")"
if [ "$status" != "200" ]; then
  echo "Server not reachable at $PUBLIC_URL (got $status). Start it with:"
  echo "  docker compose -f $COMPOSE_FILE up -d --wait"
  echo "  NODE_ENV=development PORT=3020 INTERNAL_PORT=3120 INTERNAL_HOST=127.0.0.1 \\"
  echo "    DATABASE_URL=postgres://identity:identity@localhost:5435/vcare_identity_test \\"
  echo "    REDIS_URL=redis://localhost:6382/1 npx tsx src/migrate.ts latest"
  echo "  ...then the same env with: npx tsx src/server.ts"
  exit 1
fi
echo "  public listener reachable at $PUBLIC_URL"

# ---------------------------------------------------------------------------
section "A. Health happy paths"
check "GET /api/health/live -> 200" 200 "$(call GET "$PUBLIC_URL/api/health/live")"
check "  body" '{"status":"ok"}' "$(cat "$TMP/body")"
check "  Cache-Control" "no-store" "$(header Cache-Control)"
check "  X-Request-Id present" "yes" "$([ -n "$(header X-Request-Id)" ] && echo yes || echo no)"

check "GET /api/health/ready -> 200" 200 "$(call GET "$PUBLIC_URL/api/health/ready")"
check "  body" '{"status":"ok","checks":{"database":"up","redis":"up"}}' "$(cat "$TMP/body")"
check "  Cache-Control" "no-store" "$(header Cache-Control)"

check "GET /internal/health/live -> 200" 200 "$(call GET "$INTERNAL_URL/internal/health/live")"
check "  body" '{"status":"ok"}' "$(cat "$TMP/body")"

check "GET /internal/health/ready -> 200" 200 "$(call GET "$INTERNAL_URL/internal/health/ready")"
check "  body" '{"status":"ok","checks":{"database":"up","redis":"up"}}' "$(cat "$TMP/body")"
check "  Cache-Control" "no-store" "$(header Cache-Control)"

# ---------------------------------------------------------------------------
section "B. X-Request-Id"
SENT="$(uuid)"
curl -s -o "$TMP/body" -D "$TMP/headers" -H "X-Request-Id: $SENT" "$PUBLIC_URL/api/health/live" >/dev/null
check "valid UUID is echoed" "$SENT" "$(header X-Request-Id)"

UPPER="$(uuid | tr "[:lower:]" "[:upper:]")"
curl -s -o "$TMP/body" -D "$TMP/headers" -H "X-Request-Id: $UPPER" "$PUBLIC_URL/api/health/live" >/dev/null
check "uppercase UUID is adopted lower-cased" "$(echo "$UPPER" | tr "[:upper:]" "[:lower:]")" "$(header X-Request-Id)"

curl -s -o "$TMP/body" -D "$TMP/headers" -H "X-Request-Id: not-a-uuid" "$PUBLIC_URL/api/health/live" >/dev/null
check "malformed id is regenerated" "regenerated" \
  "$([ "$(header X-Request-Id)" != "not-a-uuid" ] && [ -n "$(header X-Request-Id)" ] && echo regenerated || echo echoed)"

curl -s -o "$TMP/body" -D "$TMP/headers" \
  -H "X-Request-Id: $(uuid)" -H "X-Request-Id: $(uuid)" "$PUBLIC_URL/api/health/live" >/dev/null
check "repeated header is regenerated (single value)" "1" "$(grep -ci "^x-request-id:" "$TMP/headers")"

SENT="$(uuid)"
curl -s -o "$TMP/body" -D "$TMP/headers" -H "X-Request-Id: $SENT" "$PUBLIC_URL/api/nope" >/dev/null
check "error body carries the sent request id" "$SENT" \
  "$(tr -d " " < "$TMP/body" | sed -n 's/.*"requestId":"\([^"]*\)".*/\1/p')"
check "error response echoes the header" "$SENT" "$(header X-Request-Id)"

SENT="$(uuid)"
curl -s -o "$TMP/body" -D "$TMP/headers" -H "X-Request-Id: $SENT" "$INTERNAL_URL/internal/health/ready" >/dev/null
check "internal listener echoes the request id" "$SENT" "$(header X-Request-Id)"

# ---------------------------------------------------------------------------
section "C. Listener isolation"
check "internal path on the PUBLIC listener -> 404" 404 "$(call GET "$PUBLIC_URL/internal/health/live")"
check "  envelope code" "NotFound" "$(sed -n 's/.*"code":"\([^"]*\)".*/\1/p' "$TMP/body")"
check "api path on the INTERNAL listener -> 404" 404 "$(call GET "$INTERNAL_URL/api/health/live")"
check "  envelope code" "NotFound" "$(sed -n 's/.*"code":"\([^"]*\)".*/\1/p' "$TMP/body")"
check "/.well-known/jwks.json not in foundation -> 404" 404 "$(call GET "$PUBLIC_URL/.well-known/jwks.json")"

# ---------------------------------------------------------------------------
section "D. Error envelope"
check "unknown public path -> 404" 404 "$(call GET "$PUBLIC_URL/api/definitely/not/here")"
check "  full envelope shape" "ok" \
  "$(grep -q '"success":false' "$TMP/body" && grep -q '"details":\[\]' "$TMP/body" && grep -q '"requestId":"' "$TMP/body" && echo ok || echo mismatch)"
check "unknown internal path -> 404" 404 "$(call GET "$INTERNAL_URL/internal/definitely/not/here")"
check "root path -> 404" 404 "$(call GET "$PUBLIC_URL/")"
check "POST on a GET-only path -> 404" 404 \
  "$(call POST "$PUBLIC_URL/api/health/live" -H "Content-Type: application/json" -d '{}')"
check "malformed JSON -> 400" 400 \
  "$(call POST "$PUBLIC_URL/api/health/live" -H "Content-Type: application/json" -d '{bad')"
check "  code" "ValidationFailed" "$(sed -n 's/.*"code":"\([^"]*\)".*/\1/p' "$TMP/body")"
check "  detail" "must be valid JSON" "$(sed -n 's/.*"issue":"\([^"]*\)".*/\1/p' "$TMP/body")"

# ---------------------------------------------------------------------------
section "E. Security headers"
call GET "$PUBLIC_URL/api/health/live" >/dev/null
check "X-Powered-By absent" "absent" "$([ -z "$(header X-Powered-By)" ] && echo absent || echo present)"
check "X-Content-Type-Options" "nosniff" "$(header X-Content-Type-Options)"
check "Referrer-Policy" "no-referrer" "$(header Referrer-Policy)"
check "Content-Security-Policy present" "yes" "$([ -n "$(header Content-Security-Policy)" ] && echo yes || echo no)"

# ---------------------------------------------------------------------------
section "F. CORS (development allowlist only)"
curl -s -o "$TMP/body" -D "$TMP/headers" -H "Origin: $CORS_ORIGIN" "$PUBLIC_URL/api/health/live" >/dev/null
check "allowed origin is reflected" "$CORS_ORIGIN" "$(header Access-Control-Allow-Origin)"
check "  credentials" "true" "$(header Access-Control-Allow-Credentials)"
check "  Vary" "Origin" "$(header Vary)"

curl -s -o "$TMP/body" -D "$TMP/headers" -H "Origin: http://evil.example.test" "$PUBLIC_URL/api/health/live" >/dev/null
check "disallowed origin gets no CORS headers" "none" \
  "$([ -z "$(header Access-Control-Allow-Origin)" ] && echo none || echo present)"

curl -s -o "$TMP/body" -D "$TMP/headers" -X OPTIONS \
  -H "Origin: $CORS_ORIGIN" -H "Access-Control-Request-Method: GET" \
  "$PUBLIC_URL/api/health/live" -w "%{http_code}" > "$TMP/code"
check "preflight -> 204" "204" "$(cat "$TMP/code")"
check "  Max-Age" "600" "$(header Access-Control-Max-Age)"

curl -s -o "$TMP/body" -D "$TMP/headers" -H "Origin: $CORS_ORIGIN" "$INTERNAL_URL/internal/health/live" >/dev/null
check "internal listener never mounts CORS" "none" \
  "$([ -z "$(header Access-Control-Allow-Origin)" ] && echo none || echo present)"

# ---------------------------------------------------------------------------
# Infrastructure cases: readiness decision table rows 2 and 3 (spec §3.2).
# Off by default because they stop containers.
if [ "$RUN_INFRA_CASES" = "1" ]; then
  wait_for() { # wait_for <grep pattern> <seconds>
    local pattern="$1" limit="$2" i
    for i in $(seq 1 "$limit"); do
      curl -s "$PUBLIC_URL/api/health/ready" | grep -q "$pattern" && return 0
      sleep 1
    done
    return 1
  }
  restore() {
    docker compose -f "$COMPOSE_FILE" start redis postgres >/dev/null 2>&1 || true
  }
  trap 'restore; rm -rf "$TMP"' EXIT

  section "G. Redis down -> degraded (Redis is Tier 2, ADR 0008)"
  docker compose -f "$COMPOSE_FILE" stop redis >/dev/null
  wait_for '"redis":"down"' 20 || true
  check "public readiness -> 200" 200 "$(call GET "$PUBLIC_URL/api/health/ready")"
  check "  body" '{"status":"degraded","checks":{"database":"up","redis":"down"}}' "$(cat "$TMP/body")"
  check "internal readiness -> 200" 200 "$(call GET "$INTERNAL_URL/internal/health/ready")"
  check "  body" '{"status":"degraded","checks":{"database":"up","redis":"down"}}' "$(cat "$TMP/body")"
  check "liveness unaffected -> 200" 200 "$(call GET "$PUBLIC_URL/api/health/live")"

  section "H. Redis restored"
  docker compose -f "$COMPOSE_FILE" start redis >/dev/null
  wait_for '"redis":"up"' 30 || true
  check "public readiness -> 200 ok" '{"status":"ok","checks":{"database":"up","redis":"up"}}' \
    "$(call GET "$PUBLIC_URL/api/health/ready" >/dev/null; cat "$TMP/body")"

  section "I. Postgres down -> 503 (Postgres is the only fatal dependency, ADR 0014)"
  docker compose -f "$COMPOSE_FILE" stop postgres >/dev/null
  wait_for '"database":"down"' 20 || true
  check "public readiness -> 503" 503 "$(call GET "$PUBLIC_URL/api/health/ready")"
  check "  body" '{"status":"down","checks":{"database":"down","redis":"up"}}' "$(cat "$TMP/body")"
  check "internal readiness -> 503" 503 "$(call GET "$INTERNAL_URL/internal/health/ready")"
  check "public liveness still -> 200" 200 "$(call GET "$PUBLIC_URL/api/health/live")"
  check "internal liveness still -> 200" 200 "$(call GET "$INTERNAL_URL/internal/health/live")"
  check "error envelope still served -> 404" 404 "$(call GET "$PUBLIC_URL/api/nope")"

  section "J. Postgres restored"
  docker compose -f "$COMPOSE_FILE" start postgres >/dev/null
  wait_for '"status":"ok"' 60 || true
  check "public readiness -> 200 ok" '{"status":"ok","checks":{"database":"up","redis":"up"}}' \
    "$(call GET "$PUBLIC_URL/api/health/ready" >/dev/null; cat "$TMP/body")"
  check "internal readiness -> 200 ok" '{"status":"ok","checks":{"database":"up","redis":"up"}}' \
    "$(call GET "$INTERNAL_URL/internal/health/ready" >/dev/null; cat "$TMP/body")"
else
  section "G-J. Infrastructure cases skipped"
  echo "  set RUN_INFRA_CASES=1 to stop/start Redis and Postgres and assert the readiness table"
fi

# ---------------------------------------------------------------------------
printf "\n=== Result: %s pass / %s fail ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
