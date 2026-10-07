#!/usr/bin/env bash
# Manual QA for the `users` module of identity-service (docs/users/manual-qa.md).
#
# Drives GET /api/users, GET /api/users/{id}, PATCH /api/users/{id}/status, GET /api/users/{id}/sessions and
# DELETE /api/users/{id}/sessions with CURL and compares status, error.code, shape, headers and the echoed
# X-Request-Id with contracts/openapi.yaml and docs/users/spec.md.
#
# Usage (server already running against a migrated database):
#   DATABASE_URL=postgres://identity:identity@localhost:5432/vcare_identity_test ./scripts/curl-test-users.sh
#   BASE_URL=http://localhost:3000 REDIS_DB=2 ./scripts/curl-test-users.sh
#
# Requirements: bash, curl, python 3 (JSON + uuid), psql, node (repo root, for one argon2 hash).
#
# How it runs without secrets:
#   * Accounts are QA fixtures inserted with SQL (psql via DATABASE_URL): admins, patients, a doctor, pending and
#     rejected patients, a soft-deleted patient. All emails are synthetic (@example.test) and unique per run.
#     They share one throwaway password generated per run (never printed).
#   * Tokens are obtained the way a client would: POST /api/auth/login, capture data.accessToken and the
#     vcare_rt Set-Cookie. Nothing token-, cookie- or email-shaped is echoed.
#   * Account-state cases that the API cannot produce (a suspended or soft-deleted admin holding a still-valid
#     access token) are produced with SQL after login.
# The script is idempotent (unique emails per run) and leaves the rows it created in place.
# Exit status is non-zero when any check fails.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
DATABASE_URL="${DATABASE_URL:-postgres://identity:identity@localhost:5432/vcare_identity_test}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RUN="$(date +%s)${RANDOM}"
PW="QaPass-${RUN}-zz9!"
PASS=0; FAIL=0; N=0; RID_OK=0; RID_BAD=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

uuid() { python -c "import uuid;print(uuid.uuid4())" | tr -d '\r'; }
psql_q() { psql "$DATABASE_URL" -tAqc "$1" | tr -d '\r'; }
header() { { grep -i "^$1:" "$TMP/headers" || true; } | head -1 | cut -d" " -f2- | tr -d "\r"; }
jget() {
  python -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception:
    print(""); sys.exit(0)
for k in sys.argv[1].split("."):
    if d is None: break
    if isinstance(d,list):
        try: d=d[int(k)]
        except Exception: d=None
    elif isinstance(d,dict): d=d.get(k)
    else: d=None
print("" if d is None else (json.dumps(d) if isinstance(d,(dict,list,bool)) else d))' "$1" < "$TMP/body" | tr -d '\r'
}

STATUS=""; RID=""
# req METHOD PATH TOKEN [BODY] [extra curl args...]   (TOKEN "-" = no Authorization header)
req() {
  local method="$1" path="$2" token="$3" body="${4:-}"; shift 4 || shift $#
  RID="$(uuid)"
  local args=(-s -o "$TMP/body" -D "$TMP/headers" -w "%{http_code}" -X "$method" "$BASE_URL$path" -H "X-Request-Id: $RID")
  [ "$token" != "-" ] && args+=(-H "Authorization: Bearer $token")
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" --data "$body"); fi
  args+=("$@")
  STATUS="$(curl "${args[@]}" | tr -d '\r')"
  if [ "$(header x-request-id)" = "$RID" ]; then RID_OK=$((RID_OK+1)); else RID_BAD=$((RID_BAD+1)); fi
}

# check "<label>" METHOD PATH expectedStatus expectedCode(or -)  — runs after req
check() {
  local label="$1" want="$2" code="${3:--}" got_code ok=1
  N=$((N+1)); got_code="$(jget error.code)"
  [ "$STATUS" = "$want" ] || ok=0
  if [ "$code" != "-" ]; then [ "$got_code" = "$code" ] || ok=0; fi
  if [ "$want" != "204" ] && [ "$want" != "-" ]; then
    case "$STATUS" in 2??) [ "$(jget success)" = "true" ] || ok=0 ;; *) [ "$(jget success)" = "false" ] || ok=0 ;; esac
  fi
  if [ "$ok" = 1 ]; then PASS=$((PASS+1)); printf "%03d PASS %-62s want %s %s got %s %s\n" "$N" "$label" "$want" "$code" "$STATUS" "$got_code"
  else FAIL=$((FAIL+1)); printf "%03d FAIL %-62s want %s %s got %s %s\n" "$N" "$label" "$want" "$code" "$STATUS" "$got_code"; fi
}
# assert "<label>" "<actual>" "<expected>"
assert() {
  N=$((N+1))
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf "%03d PASS %-62s (%s)\n" "$N" "$1" "$3"
  else FAIL=$((FAIL+1)); printf "%03d FAIL %-62s expected '%s' got '%s'\n" "$N" "$1" "$3" "$2"; fi
}

# ----------------------------------------------------------------------------- fixtures
echo "== fixtures"
HASH="$(cd "$ROOT" && PW="$PW" node -e 'import("argon2").then(a=>a.hash(process.env.PW,{type:a.argon2id,memoryCost:19456,timeCost:2,parallelism:1})).then(h=>process.stdout.write(h))')"
mkuser() { # mkuser <tag> <role> <status>  -> prints id
  psql_q "INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at, timezone, locale)
          VALUES ('qa-${RUN}-$1@example.test', '$HASH', 'QA $1', '$2', '$3', now(), 'UTC', 'en') RETURNING id"
}
ADMIN_A_ID="$(mkuser adminA admin active)"
ADMIN_B_ID="$(mkuser adminB admin active)"
ADMIN_C_ID="$(mkuser adminC admin active)"   # suspended in SQL after login (live-row check)
ADMIN_E_ID="$(mkuser adminE admin active)"   # soft-deleted in SQL after login
P1_ID="$(mkuser patient1 patient active)"
P2_ID="$(mkuser patient2 patient active)"
D_ID="$(mkuser doctor doctor active)"
PP_ID="$(mkuser pendingp patient pending)"
RP_ID="$(mkuser rejectedp patient rejected)"
DP_ID="$(mkuser deletedp patient active)"
psql_q "UPDATE users SET deleted_at = now() WHERE id = $DP_ID" >/dev/null
em() { echo "qa-${RUN}-$1@example.test"; }

COOKIE_P1=""
login() { # login <tag> -> sets TOKEN (and LAST_COOKIE)
  RID="$(uuid)"
  local st
  st="$(curl -s -o "$TMP/body" -D "$TMP/headers" -w "%{http_code}" -X POST "$BASE_URL/api/auth/login" \
        -H "Content-Type: application/json" -H "X-Request-Id: $RID" \
        --data "{\"email\":\"$(em "$1")\",\"password\":\"$PW\"}" | tr -d '\r')"
  STATUS="$st"
  TOKEN="$(jget data.accessToken)"
  LAST_COOKIE="$({ grep -i '^set-cookie: vcare_rt=' "$TMP/headers" || true; } | head -1 | sed -E 's/^[Ss]et-[Cc]ookie: (vcare_rt=[^;]*).*/\1/' | tr -d '\r')"
}
login adminA; ADMIN_A="$TOKEN"
login adminB; ADMIN_B="$TOKEN"
login adminC; ADMIN_C="$TOKEN"
login adminE; ADMIN_E="$TOKEN"
login patient2; PATIENT="$TOKEN"
login doctor; DOCTOR="$TOKEN"
# three live sessions for patient1 (three families)
login patient1; P1_TOKEN="$TOKEN"; COOKIE_P1="$LAST_COOKIE"
login patient1; login patient1
for v in ADMIN_A ADMIN_B ADMIN_C ADMIN_E PATIENT DOCTOR P1_TOKEN; do
  [ -n "${!v}" ] || { echo "fixture login failed for $v (rate limit or server down?)"; exit 2; }
done
echo "tokens obtained for 7 principals (values never printed)"
ABSENT_ID=987654321

# ----------------------------------------------------------------------------- RBAC / authn on all five routes
echo; echo "== authn / RBAC on every route"
for route in "GET /api/users" "GET /api/users/$P2_ID" "PATCH /api/users/$P2_ID/status" "GET /api/users/$P2_ID/sessions" "DELETE /api/users/$P2_ID/sessions"; do
  m="${route%% *}"; p="${route#* }"; b=""
  [ "$m" = "PATCH" ] && b='{"status":"suspended","reason":"qa"}'
  req "$m" "$p" - "$b";                 check "$route no token" 401 Unauthorized
  req "$m" "$p" "garbage.token.value" "$b"; check "$route malformed token" 401 Unauthorized
  req "$m" "$p" "$PATIENT" "$b";        check "$route patient" 403 Forbidden
  req "$m" "$p" "$DOCTOR" "$b";         check "$route doctor" 403 Forbidden
  req "$m" "$p" "$PATIENT" "$b" -H "X-Role: admin" -H "X-User-Id: $ADMIN_A_ID"; check "$route patient + forged X-Role/X-User-Id" 403 Forbidden
done

# ----------------------------------------------------------------------------- GET /api/users
echo; echo "== GET /api/users"
req GET "/api/users" "$ADMIN_A" ""; check "list default" 200
assert "list: meta has nextCursor/hasMore/count" "$(jget meta | python -c 'import json,sys;print(",".join(sorted(json.load(sys.stdin))))')" "count,hasMore,nextCursor"
assert "list: Cache-Control no-store" "$(header cache-control)" "no-store"
assert "list: data[0] has no passwordHash/deletedAt" "$(jget data.0 | python -c 'import json,sys;d=json.load(sys.stdin);print(any(k in d for k in ("passwordHash","password_hash","deletedAt","tokenHash")))')" "False"
assert "list: data[0] keys match contract User" "$(jget data.0 | python -c 'import json,sys;print(",".join(sorted(json.load(sys.stdin))))')" "avatarUrl,createdAt,email,emailVerifiedAt,fullName,id,locale,phone,role,status,timezone,updatedAt"
assert "list: soft-deleted user absent from page" "$(jget data | python -c "import json,sys;print(any(u['id']==$DP_ID for u in json.load(sys.stdin)))")" "False"
req GET "/api/users?limit=2" "$ADMIN_A" ""; check "list limit=2" 200
assert "list limit=2: count" "$(jget meta.count)" "2"
assert "list limit=2: hasMore" "$(jget meta.hasMore)" "true"
IDS1="$(jget data | python -c 'import json,sys;print(",".join(str(u["id"]) for u in json.load(sys.stdin)))')"
CUR="$(jget meta.nextCursor)"
req GET "/api/users?limit=2&cursor=$CUR" "$ADMIN_A" ""; check "list page 2" 200
IDS2="$(jget data | python -c 'import json,sys;print(",".join(str(u["id"]) for u in json.load(sys.stdin)))')"
assert "list page 2: no overlap with page 1" "$(python -c "print(bool(set('$IDS1'.split(','))&set('$IDS2'.split(','))))")" "False"
assert "list: newest first (page1 ids > page2 ids)" "$(python -c "print(min(map(int,'$IDS1'.split(',')))>max(map(int,'$IDS2'.split(','))))")" "True"
req GET "/api/users?role=doctor" "$ADMIN_A" ""; check "list role=doctor" 200
assert "list role=doctor: only doctors" "$(jget data | python -c 'import json,sys;print(set(u["role"] for u in json.load(sys.stdin)))')" "{'doctor'}"
req GET "/api/users?status=pending" "$ADMIN_A" ""; check "list status=pending" 200
assert "list status=pending: only pending" "$(jget data | python -c 'import json,sys;print(set(u["status"] for u in json.load(sys.stdin)))')" "{'pending'}"
UP_EMAIL="$(em patient2 | tr 'a-z' 'A-Z')"
req GET "/api/users?email=${UP_EMAIL}" "$ADMIN_A" ""; check "list email filter (upper-case, CITEXT)" 200
assert "list email filter: exactly patient2" "$(jget data | python -c "import json,sys;print([u['id'] for u in json.load(sys.stdin)]==[$P2_ID])")" "True"
req GET "/api/users?email=$(em deletedp)" "$ADMIN_A" ""; check "list email of soft-deleted user" 200
assert "list email of soft-deleted: empty page" "$(jget meta.count)" "0"
req GET "/api/users?email=nobody-${RUN}@example.test" "$ADMIN_A" ""; check "list email no match" 200
assert "list email no match: empty data" "$(jget data)" "[]"
req GET "/api/users?limit=0" "$ADMIN_A" "";            check "list limit=0" 400 ValidationFailed
req GET "/api/users?limit=101" "$ADMIN_A" "";          check "list limit=101" 400 ValidationFailed
req GET "/api/users?limit=abc" "$ADMIN_A" "";          check "list limit=abc" 400 ValidationFailed
req GET "/api/users?role=nurse" "$ADMIN_A" "";         check "list role=nurse" 400 ValidationFailed
req GET "/api/users?status=banned" "$ADMIN_A" "";      check "list status=banned" 400 ValidationFailed
req GET "/api/users?email=not-an-email" "$ADMIN_A" ""; check "list email=not-an-email" 400 ValidationFailed
req GET "/api/users?cursor=not-a-cursor" "$ADMIN_A" ""; check "list malformed cursor" 400 ValidationFailed
req GET "/api/users?foo=bar" "$ADMIN_A" "";            check "list unknown query param" 400 ValidationFailed
req GET "/api/users?limit=100" "$ADMIN_A" "";          check "list limit=100 (max)" 200

# ----------------------------------------------------------------------------- GET /api/users/{id}
echo; echo "== GET /api/users/{id}"
req GET "/api/users/$P2_ID" "$ADMIN_A" ""; check "get existing patient" 200
assert "get: id echoed" "$(jget data.id)" "$P2_ID"
assert "get: Cache-Control no-store" "$(header cache-control)" "no-store"
req GET "/api/users/$D_ID" "$ADMIN_A" "";  check "get doctor" 200
req GET "/api/users/$ABSENT_ID" "$ADMIN_A" ""; check "get absent id" 404 NotFound
req GET "/api/users/$DP_ID" "$ADMIN_A" "";     check "get soft-deleted id" 404 NotFound
req GET "/api/users/abc" "$ADMIN_A" "";        check "get id=abc" 400 ValidationFailed
req GET "/api/users/0" "$ADMIN_A" "";          check "get id=0" 400 ValidationFailed
req GET "/api/users/-1" "$ADMIN_A" "";         check "get id=-1" 400 ValidationFailed

# ----------------------------------------------------------------------------- GET sessions
echo; echo "== GET /api/users/{id}/sessions"
req GET "/api/users/$P1_ID/sessions" "$ADMIN_A" ""; check "sessions of patient1 (3 logins)" 200
assert "sessions: 3 live families" "$(jget meta.count)" "3"
assert "sessions: keys match contract Session" "$(jget data.0 | python -c 'import json,sys;print(",".join(sorted(json.load(sys.stdin))))')" "createdAt,deviceInfo,expiresAt,familyId,lastUsedAt"
assert "sessions: Cache-Control no-store" "$(header cache-control)" "no-store"
assert "sessions: body holds no token/hash fields" "$(grep -ciE 'token|hash|vcare_rt' "$TMP/body" || true)" "0"
req GET "/api/users/$P1_ID/sessions?limit=2" "$ADMIN_A" ""; check "sessions limit=2" 200
F1="$(jget data | python -c 'import json,sys;print(",".join(s["familyId"] for s in json.load(sys.stdin)))')"
assert "sessions limit=2: hasMore" "$(jget meta.hasMore)" "true"
SC="$(jget meta.nextCursor)"
req GET "/api/users/$P1_ID/sessions?limit=2&cursor=$SC" "$ADMIN_A" ""; check "sessions page 2" 200
F2="$(jget data | python -c 'import json,sys;print(",".join(s["familyId"] for s in json.load(sys.stdin)))')"
assert "sessions page 2: one remaining, no overlap" "$(python -c "a=set('$F1'.split(','));b=set('$F2'.split(','));print(len(b),bool(a&b))")" "1 False"
req GET "/api/users/$P1_ID/sessions?cursor=bogus" "$ADMIN_A" "";   check "sessions malformed cursor" 400 ValidationFailed
req GET "/api/users/$P1_ID/sessions?limit=0" "$ADMIN_A" "";        check "sessions limit=0" 400 ValidationFailed
req GET "/api/users/$P1_ID/sessions?role=admin" "$ADMIN_A" "";     check "sessions unknown query param" 400 ValidationFailed
req GET "/api/users/$ABSENT_ID/sessions" "$ADMIN_A" "";            check "sessions absent user" 404 NotFound
req GET "/api/users/$DP_ID/sessions" "$ADMIN_A" "";                check "sessions soft-deleted user" 404 NotFound
req GET "/api/users/abc/sessions" "$ADMIN_A" "";                   check "sessions id=abc" 400 ValidationFailed
req GET "/api/users/$P2_ID/sessions" "$ADMIN_A" "";                check "sessions of user (1 session from login)" 200
req GET "/api/users/$PP_ID/sessions" "$ADMIN_A" "";                check "sessions of user with none" 200
assert "sessions none: empty data" "$(jget data)" "[]"

# ----------------------------------------------------------------------------- PATCH status
echo; echo "== PATCH /api/users/{id}/status"
IDEM="$(uuid)"
req PATCH "/api/users/$P1_ID/status" "$ADMIN_A" '{"status":"suspended","reason":"qa suspension"}' -H "Idempotency-Key: $IDEM"; check "suspend patient1" 200
assert "suspend: data.status" "$(jget data.status)" "suspended"
assert "suspend: data keys" "$(jget data | python -c 'import json,sys;print(",".join(sorted(json.load(sys.stdin))))')" "id,status,updatedAt"
assert "suspend: Cache-Control no-store" "$(header cache-control)" "no-store"
assert "suspend: 1 history row, actor=admin, service null" "$(psql_q "SELECT count(*)||','||bool_and(actor_user_id=$ADMIN_A_ID)||','||bool_and(actor_service IS NULL)||','||bool_and(request_id IS NOT NULL) FROM user_status_changes WHERE user_id=$P1_ID")" "1,true,true,true"
assert "suspend: 0 live refresh tokens" "$(psql_q "SELECT count(*) FROM refresh_tokens WHERE user_id=$P1_ID AND revoked_at IS NULL")" "0"
assert "suspend: tokens revoked as status_changed" "$(psql_q "SELECT string_agg(DISTINCT revoked_reason, ',') FROM refresh_tokens WHERE user_id=$P1_ID")" "status_changed"
RID="$(uuid)"; st="$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST "$BASE_URL/api/auth/refresh" -H "Cookie: $COOKIE_P1" -H "X-Request-Id: $RID" | tr -d '\r')"; STATUS="$st"
# The family was already revoked (status_changed) by the suspension, so the token is simply unknown/revoked:
# 401 RefreshTokenInvalid (matches tests/integration/users/concurrency.test.ts). docs/users/spec.md BR-8 words this as
# 403 AccountSuspended; see docs/users/manual-qa.md note N-1.
check "suspended patient1 refresh (revoked family)" 401 RefreshTokenInvalid
login patient1; check "suspended patient1 login" 403 AccountSuspended
req PATCH "/api/users/$P1_ID/status" "$ADMIN_A" '{"status":"suspended","reason":"qa again"}'; check "suspend again (no-op)" 200
assert "no-op: history still 1 row" "$(psql_q "SELECT count(*) FROM user_status_changes WHERE user_id=$P1_ID")" "1"
req PATCH "/api/users/$P1_ID/status" "$ADMIN_A" '{"status":"suspended","reason":"qa suspension"}' -H "Idempotency-Key: $IDEM"; check "replay with same Idempotency-Key" 200
req PATCH "/api/users/$P1_ID/status" "$ADMIN_A" '{"status":"active","reason":"qa reinstate"}'; check "reinstate patient1" 200
assert "reinstate: data.status" "$(jget data.status)" "active"
assert "reinstate: 2 history rows" "$(psql_q "SELECT count(*) FROM user_status_changes WHERE user_id=$P1_ID")" "2"
login patient1; assert "reinstated patient1 can log in" "$STATUS" "200"
req PATCH "/api/users/$P1_ID/status" "$ADMIN_A" '{"status":"active","reason":"qa same"}'; check "active -> active (no-op)" 200
assert "no-op: history still 2 rows" "$(psql_q "SELECT count(*) FROM user_status_changes WHERE user_id=$P1_ID")" "2"

req PATCH "/api/users/$ADMIN_A_ID/status" "$ADMIN_A" '{"status":"suspended","reason":"qa"}'; check "target self" 403 Forbidden
req PATCH "/api/users/$ADMIN_A_ID/status" "$ADMIN_A" '{"status":"active","reason":"qa"}';    check "target self, same status" 403 Forbidden
req PATCH "/api/users/$ADMIN_B_ID/status" "$ADMIN_A" '{"status":"suspended","reason":"qa"}'; check "target another admin" 403 Forbidden
req PATCH "/api/users/$D_ID/status" "$ADMIN_A" '{"status":"suspended","reason":"qa"}';       check "target doctor" 403 Forbidden
req PATCH "/api/users/$D_ID/status" "$ADMIN_A" '{"status":"active","reason":"qa"}';          check "target doctor, same status" 403 Forbidden
assert "refused targets wrote no history" "$(psql_q "SELECT count(*) FROM user_status_changes WHERE user_id IN ($ADMIN_A_ID,$ADMIN_B_ID,$D_ID)")" "0"
req PATCH "/api/users/$PP_ID/status" "$ADMIN_A" '{"status":"suspended","reason":"qa"}';     check "suspend pending patient" 409 InvalidStatusTransition
req PATCH "/api/users/$RP_ID/status" "$ADMIN_A" '{"status":"active","reason":"qa"}';        check "activate rejected patient" 409 InvalidStatusTransition
req PATCH "/api/users/$P2_ID/status" "$ADMIN_A" '{"status":"suspended","reason":"qa"}' ;    check "suspend patient2 (setup)" 200
req PATCH "/api/users/$ABSENT_ID/status" "$ADMIN_A" '{"status":"suspended","reason":"qa"}'; check "absent target" 404 NotFound
req PATCH "/api/users/$DP_ID/status" "$ADMIN_A" '{"status":"suspended","reason":"qa"}';     check "soft-deleted target" 404 NotFound
req PATCH "/api/users/abc/status" "$ADMIN_A" '{"status":"suspended","reason":"qa"}';        check "id=abc" 400 ValidationFailed
req PATCH "/api/users/0/status" "$ADMIN_A" '{"status":"suspended","reason":"qa"}';          check "id=0" 400 ValidationFailed
req PATCH "/api/users/$P2_ID/status" "$ADMIN_A" '{"status":"pending","reason":"qa"}';       check "status=pending" 400 ValidationFailed
req PATCH "/api/users/$P2_ID/status" "$ADMIN_A" '{"status":"rejected","reason":"qa"}';      check "status=rejected" 400 ValidationFailed
req PATCH "/api/users/$P2_ID/status" "$ADMIN_A" '{"status":"bogus","reason":"qa"}';         check "status=bogus" 400 ValidationFailed
req PATCH "/api/users/$P2_ID/status" "$ADMIN_A" '{"reason":"qa"}';                          check "missing status" 400 ValidationFailed
req PATCH "/api/users/$P2_ID/status" "$ADMIN_A" '{"status":"active"}';                      check "missing reason" 400 ValidationFailed
req PATCH "/api/users/$P2_ID/status" "$ADMIN_A" '{"status":"active","reason":""}';          check "empty reason" 400 ValidationFailed
req PATCH "/api/users/$P2_ID/status" "$ADMIN_A" '{"status":"active","reason":"   "}';       check "blank reason" 400 ValidationFailed
LONG="$(python -c 'print("x"*501)')"
req PATCH "/api/users/$P2_ID/status" "$ADMIN_A" "{\"status\":\"active\",\"reason\":\"$LONG\"}"; check "reason 501 chars" 400 ValidationFailed
req PATCH "/api/users/$P2_ID/status" "$ADMIN_A" '{"status":"active","reason":"qa","role":"admin"}'; check "extra body field" 400 ValidationFailed
req PATCH "/api/users/$P2_ID/status" "$ADMIN_A" '{"status":"active","reason":"qa"}';        check "reinstate patient2 (cleanup)" 200

# stale-claim / live-row checks (D-5)
echo; echo "== live actor re-read (admin suspended / deleted after token issue)"
psql_q "UPDATE users SET status='suspended' WHERE id=$ADMIN_C_ID" >/dev/null
req PATCH "/api/users/$P2_ID/status" "$ADMIN_C" '{"status":"suspended","reason":"qa"}'; check "PATCH status by admin suspended since issue" 403 AccountSuspended
req DELETE "/api/users/$P2_ID/sessions" "$ADMIN_C" "";                                  check "DELETE sessions by admin suspended since issue" 403 AccountSuspended
req GET "/api/users/$P2_ID" "$ADMIN_C" "";                                              check "GET by admin suspended since issue (claim only, residual)" 200
psql_q "UPDATE users SET deleted_at=now() WHERE id=$ADMIN_E_ID" >/dev/null
req PATCH "/api/users/$P2_ID/status" "$ADMIN_E" '{"status":"suspended","reason":"qa"}'; check "PATCH status by soft-deleted admin" 401 Unauthorized
req DELETE "/api/users/$P2_ID/sessions" "$ADMIN_E" "";                                  check "DELETE sessions by soft-deleted admin" 401 Unauthorized

# ----------------------------------------------------------------------------- DELETE sessions
echo; echo "== DELETE /api/users/{id}/sessions"
login patient1; P1_TOKEN="$TOKEN"; COOKIE_P1="$LAST_COOKIE"
req DELETE "/api/users/$P1_ID/sessions" "$ADMIN_A" "";  check "revoke all sessions of patient1" 204
assert "revoke: empty body" "$(wc -c < "$TMP/body" | tr -d ' ')" "0"
assert "revoke: 0 live tokens" "$(psql_q "SELECT count(*) FROM refresh_tokens WHERE user_id=$P1_ID AND revoked_at IS NULL")" "0"
assert "revoke: reason admin_revoked present" "$(psql_q "SELECT count(*) > 0 FROM refresh_tokens WHERE user_id=$P1_ID AND revoked_reason='admin_revoked'")" "t"
req DELETE "/api/users/$P1_ID/sessions" "$ADMIN_A" "";  check "revoke again (idempotent)" 204
req DELETE "/api/users/$P1_ID/sessions" "$ADMIN_A" '{"ignored":true}'; check "revoke with a body (ignored)" 204
req GET "/api/users/$P1_ID/sessions" "$ADMIN_A" "";     check "sessions after revoke" 200
assert "sessions after revoke: empty" "$(jget data)" "[]"
RID="$(uuid)"; STATUS="$(curl -s -o "$TMP/body" -w '%{http_code}' -X POST "$BASE_URL/api/auth/refresh" -H "Cookie: $COOKIE_P1" -H "X-Request-Id: $RID" | tr -d '\r')"
check "refresh after admin revoke" 401
req DELETE "/api/users/$ABSENT_ID/sessions" "$ADMIN_A" ""; check "revoke absent user" 404 NotFound
req DELETE "/api/users/$DP_ID/sessions" "$ADMIN_A" "";     check "revoke soft-deleted user" 404 NotFound
req DELETE "/api/users/abc/sessions" "$ADMIN_A" "";        check "revoke id=abc" 400 ValidationFailed
req DELETE "/api/users/$ADMIN_A_ID/sessions" "$ADMIN_A" ""; check "revoke own sessions (allowed)" 204

# ----------------------------------------------------------------------------- request id handling
echo; echo "== X-Request-Id"
STATUS="$(curl -s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' "$BASE_URL/api/users" -H "Authorization: Bearer $ADMIN_B" -H "X-Request-Id: not-a-uuid" | tr -d '\r')"
N=$((N+1))
if [ "$(header x-request-id)" != "not-a-uuid" ] && [ -n "$(header x-request-id)" ]; then PASS=$((PASS+1)); echo "$(printf %03d $N) PASS invalid X-Request-Id regenerated"; else FAIL=$((FAIL+1)); echo "$(printf %03d $N) FAIL invalid X-Request-Id not regenerated"; fi
assert "X-Request-Id echoed on every request() call (mismatches)" "$RID_BAD" "0"

echo; echo "== summary: $PASS pass / $FAIL fail ($N checks; X-Request-Id echoed on $RID_OK requests)"
[ "$FAIL" = 0 ]
