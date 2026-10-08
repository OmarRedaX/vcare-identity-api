#!/usr/bin/env bash
# Manual QA for the `internal-users` module of identity-service (docs/internal-users/manual-qa.md).
#
# Drives the three guarded routes of the INTERNAL listener with CURL:
#   GET   /internal/users?ids=            (Case 2, scope users:read)
#   GET   /internal/users/contacts?ids=   (Case 5, scope users:contact:read, care-service only)
#   PATCH /internal/users/{id}/status     (Cases 1, 3, 4, scope users:status:write, doctor targets only: ADR 0025)
# and compares status, error.code, shape, headers, the echoed X-Request-Id and the database side effects (status,
# user_status_changes rows, refresh-token revocation) with contracts/openapi.yaml and docs/internal-users/spec.md.
#
# Usage (server already running against a migrated database; the script never starts or migrates anything):
#   DATABASE_URL=postgres://identity:identity@localhost:5432/vcare_identity_test \
#   PUBLIC_URL=http://localhost:3000 INTERNAL_URL=http://localhost:3100 ./scripts/curl-test-internal-users.sh
#   SERVER_LOG=server.log ./scripts/curl-test-internal-users.sh      # optional log-hygiene section
#
# DATABASE_URL must point at the SAME database the server uses. Preflight refuses to run when migration
# 20261008000100 (users:contact:read scope + care-only CHECK, ADR 0024) is not applied.
#
# Requirements: bash, curl, python 3, psql, node (repo root, for argon2 hashes).
#
# How it runs without secrets:
#   * Users are QA fixtures inserted with SQL (psql): doctors in every status, a patient, admins, soft-deleted rows.
#     All emails are synthetic (@example.test) and unique per run; one throwaway password per run (never printed).
#   * Service clients are QA fixtures inserted with SQL with a random per-run secret (hashed with argon2id).
#     users:contact:read is database-restricted to client_id `care-service`: if a live care-service row exists its
#     secret/scopes are saved and RESTORED on exit; otherwise the row is created and soft-deleted on exit.
#   * Tokens come from POST /internal/auth/token (service) and POST /api/auth/login (user), the way a client would.
#     Nothing token-, cookie-, secret- or email-shaped is echoed.
# The script is idempotent (unique ids per run). Exit status is non-zero when any check fails.
set -euo pipefail

PUBLIC_URL="${PUBLIC_URL:-http://localhost:3000}"
INTERNAL_URL="${INTERNAL_URL:-http://localhost:3100}"
DATABASE_URL="${DATABASE_URL:-postgres://identity:identity@localhost:5432/vcare_identity_test}"
SERVER_LOG="${SERVER_LOG:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

RUN="$(date +%s)${RANDOM}"
PW="QaPass-${RUN}-zz9!"
REASON="QA-REASON-${RUN}"          # free text that must never reach the logs (BR-16)
PASS=0; FAIL=0; N=0; RID_OK=0; RID_BAD=0
TMP="$(mktemp -d)"
CARE_SAVED_SQL=""; CARE_CREATED=0

psql_q() { psql "$DATABASE_URL" -tAqc "$1" | tr -d '\r'; }
cleanup() {
  if [ -n "$CARE_SAVED_SQL" ]; then psql_q "$CARE_SAVED_SQL" >/dev/null 2>&1 || true
  elif [ "$CARE_CREATED" = 1 ]; then psql_q "UPDATE service_clients SET deleted_at = now(), is_active = false, updated_at = now() WHERE client_id = 'care-service' AND deleted_at IS NULL" >/dev/null 2>&1 || true
  fi
  psql_q "UPDATE service_clients SET deleted_at = now(), is_active = false, updated_at = now() WHERE client_id LIKE 'qa-iu-${RUN}-%' AND deleted_at IS NULL" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

uuid() { python -c "import uuid;print(uuid.uuid4())" | tr -d '\r'; }
newip() { echo "10.$((RANDOM % 250)).$((RANDOM % 250)).$((1 + RANDOM % 250))"; }
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
# sorted, comma-joined keys of data (or data.N) in the last body
dkeys() { jget "$1" | python -c 'import json,sys;print(",".join(sorted(json.load(sys.stdin))))' | tr -d '\r'; }
# sorted, comma-joined ids of the data array in the last body
dids() { jget data | python -c 'import json,sys;print(",".join(str(i) for i in sorted(u["id"] for u in json.load(sys.stdin))))' | tr -d '\r'; }
sorted_ids() { python -c 'import sys;print(",".join(str(i) for i in sorted(int(x) for x in sys.argv[1:])))' "$@" | tr -d '\r'; }

STATUS=""; RID=""; LM=""; LP=""; LR=""
disp() { printf '%s' "$1" | sed -E 's#/[0-9]{5,}#/{id}#g; s#ids=[0-9,]{40,}#ids=<long list>#' | cut -c1-70; }
# _req BASE ROLE METHOD PATH TOKEN BODY [extra curl args]   (TOKEN "-" = no Authorization header)
_req() {
  local base="$1" role="$2" method="$3" path="$4" token="$5" body="${6:-}"; shift 6 || shift $#
  LR="$role"; LM="$method"; LP="$(disp "$path")"
  RID="$(uuid)"
  local args=(-s -o "$TMP/body" -D "$TMP/headers" -w "%{http_code}" -X "$method" "$base$path" -H "X-Request-Id: $RID" -H "X-Forwarded-For: $(newip)")
  [ "$token" != "-" ] && args+=(-H "Authorization: Bearer $token")
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" --data "$body"); fi
  args+=("$@")
  STATUS="$(curl "${args[@]}" | tr -d '\r')"
  if [ "$(header x-request-id)" = "$RID" ]; then RID_OK=$((RID_OK+1)); else RID_BAD=$((RID_BAD+1)); fi
}
ireq() { _req "$INTERNAL_URL" "$@"; }    # ireq ROLE METHOD PATH TOKEN [BODY] [extra...]
preq() { _req "$PUBLIC_URL" "$@"; }

row() { printf "%03d | %s | %s | %s | %s | %s | want %s | got %s\n" "$N" "$1" "$LM" "$LP" "$LR" "$2" "$3" "$4"; }
# check "<scenario>" wantStatus [wantCode|-]   (runs after a request)
check() {
  local label="$1" want="$2" code="${3:--}" got_code ok=1 wantstr
  wantstr="$want"; [ "$code" = "-" ] || wantstr="$want $code"
  N=$((N+1)); got_code="$(jget error.code)"
  [ "$STATUS" = "$want" ] || ok=0
  if [ "$code" != "-" ]; then [ "$got_code" = "$code" ] || ok=0; fi
  if [ "$want" != "204" ]; then
    case "$STATUS" in 2??) [ "$(jget success)" = "true" ] || ok=0 ;; *) [ "$(jget success)" = "false" ] || ok=0 ;; esac
  fi
  if [ "$ok" = 1 ]; then PASS=$((PASS+1)); row PASS "$label" "$wantstr" "$STATUS ${got_code}"
  else FAIL=$((FAIL+1)); row FAIL "$label" "$wantstr" "$STATUS ${got_code}"; fi
}
# assert "<scenario>" actual expected
assert() {
  N=$((N+1))
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); row PASS "$1" "$3" "$2"
  else FAIL=$((FAIL+1)); row FAIL "$1" "$3" "$2"; fi
}
assert_match() { # assert_match "<scenario>" actual regex
  N=$((N+1))
  if [[ "$2" =~ $3 ]]; then PASS=$((PASS+1)); row PASS "$1" "~ $3" "$2"
  else FAIL=$((FAIL+1)); row FAIL "$1" "~ $3" "$2"; fi
}

# ----------------------------------------------------------------------------- preflight
echo "== preflight"
code="$(curl -s -o /dev/null -w '%{http_code}' "$INTERNAL_URL/internal/health/live" || true)"
[ "$code" = "200" ] || { echo "internal listener not reachable at $INTERNAL_URL (got $code). Start: set env, npm run migrate, npm run dev"; exit 2; }
code="$(curl -s -o /dev/null -w '%{http_code}' "$PUBLIC_URL/api/health/live" || true)"
[ "$code" = "200" ] || { echo "public listener not reachable at $PUBLIC_URL (got $code)"; exit 2; }
psql_q "SELECT 1 FROM pg_constraint WHERE conname = 'chk_service_clients_contact_scope_care_only'" | grep -q 1 \
  || { echo "migration 20261008000100 (users:contact:read scope, ADR 0024) is not applied to this DATABASE_URL: run npm run migrate against the server's database"; exit 2; }
echo "listeners up; contact-scope migration applied"

# ----------------------------------------------------------------------------- fixtures: users
echo; echo "== fixtures (values never printed)"
HASH="$(cd "$ROOT" && PW="$PW" node -e 'import("argon2").then(a=>a.hash(process.env.PW,{type:a.argon2id,memoryCost:19456,timeCost:2,parallelism:1})).then(h=>process.stdout.write(h))')"
mkuser() { # mkuser <tag> <role> <status> [phone] -> id
  local phone="NULL"; [ -n "${4:-}" ] && phone="'$4'"
  psql_q "INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at, timezone, locale, phone)
          VALUES ('qa-iu-${RUN}-$1@example.test', '$HASH', 'QA $1', '$2', '$3', now(), 'UTC', 'en', $phone) RETURNING id" | head -1
}
em() { echo "qa-iu-${RUN}-$1@example.test"; }
PHONE_P="+15550100123"; PHONE_D="+15550100456"
ADM_ID="$(mkuser admin admin active)"
PAT_ID="$(mkuser patient patient active "$PHONE_P")"
DOC_ID="$(mkuser docuser doctor active "$PHONE_D")"     # user-token negative tests + lookups
D1_ID="$(mkuser d1 doctor pending)"                     # Case 1: pending -> active
D2_ID="$(mkuser d2 doctor pending)"                     # Case 1: pending -> rejected -> pending
D3_ID="$(mkuser d3 doctor active)"                      # Cases 3 and 4
D5_ID="$(mkuser d5 doctor active)"                      # repeat-suspended with a live token inserted by SQL
DX_ID="$(mkuser dx doctor pending)"                     # transition matrix (state forced with SQL)
DY_ID="$(mkuser dy doctor active)"                      # actorUserId handling
DD_ID="$(mkuser ddel doctor active)"; psql_q "UPDATE users SET deleted_at = now() WHERE id = $DD_ID" >/dev/null
PD_ID="$(mkuser pdel patient active)"; psql_q "UPDATE users SET deleted_at = now() WHERE id = $PD_ID" >/dev/null
ACTOR_DEL_ID="$(mkuser actordel admin active)"; psql_q "UPDATE users SET deleted_at = now() WHERE id = $ACTOR_DEL_ID" >/dev/null
ABSENT_ID=987654321; ABSENT_ACTOR=987654322

live()  { psql_q "SELECT count(*) FROM refresh_tokens WHERE user_id=$1 AND revoked_at IS NULL"; }
hist()  { psql_q "SELECT count(*) FROM user_status_changes WHERE user_id=$1"; }
ustat() { psql_q "SELECT status FROM users WHERE id=$1"; }
uupd()  { psql_q "SELECT updated_at FROM users WHERE id=$1"; }

# fixtures: service clients (secrets in shell variables only)
hash_secret() { (cd "$ROOT" && SEC="$1" node -e 'import("argon2").then(a=>a.hash(process.env.SEC,{type:a.argon2id,memoryCost:19456,timeCost:2,parallelism:1})).then(h=>process.stdout.write(h))'); }
newsecret() { python -c "import secrets;print(secrets.token_urlsafe(32))" | tr -d '\r'; }
READ_ID="qa-iu-${RUN}-read";  READ_SEC="$(newsecret)"
STAT_ID="qa-iu-${RUN}-status"; STAT_SEC="$(newsecret)"
CARE_ID="care-service";       CARE_SEC="$(newsecret)"
mkclient() { # mkclient id secret "scopes{...}"
  psql_q "INSERT INTO service_clients (client_id, name, client_secret_hash, allowed_scopes, allowed_audiences, is_active, created_at, updated_at)
          VALUES ('$1', 'QA $1', '$(hash_secret "$2")', '$3'::text[], '{vcare-identity}'::text[], true, now(), now())" >/dev/null
}
mkclient "$READ_ID" "$READ_SEC" '{users:read}'
mkclient "$STAT_ID" "$STAT_SEC" '{users:status:write}'
CARE_SCOPES='{users:read,users:status:write,users:contact:read}'
if [ "$(psql_q "SELECT count(*) FROM service_clients WHERE client_id='care-service' AND deleted_at IS NULL")" = "1" ]; then
  CARE_SAVED_SQL="$(psql_q "SELECT format('UPDATE service_clients SET client_secret_hash=%L, previous_secret_hash=%L, previous_secret_expires_at=%L, allowed_scopes=%L::text[], allowed_audiences=%L::text[], is_active=%L, secret_rotated_at=%L, updated_at=%L WHERE id=%s', client_secret_hash, previous_secret_hash, previous_secret_expires_at, allowed_scopes, allowed_audiences, is_active, secret_rotated_at, updated_at, id) FROM service_clients WHERE client_id='care-service' AND deleted_at IS NULL")"
  psql_q "UPDATE service_clients SET client_secret_hash='$(hash_secret "$CARE_SEC")', previous_secret_hash=NULL, previous_secret_expires_at=NULL, allowed_scopes='$CARE_SCOPES'::text[], is_active=true, updated_at=now() WHERE client_id='care-service' AND deleted_at IS NULL" >/dev/null
  echo "existing care-service row found: temporarily re-keyed, restored on exit"
else
  CARE_CREATED=1; mkclient "$CARE_ID" "$CARE_SEC" "$CARE_SCOPES"
  echo "care-service row created for this run, soft-deleted on exit"
fi

# tokens
mint() { # mint client secret "scope list" -> prints access token ("" on failure)
  printf '{"grant_type":"client_credentials","client_id":"%s","client_secret":"%s","scope":"%s","audience":"vcare-identity"}' "$1" "$2" "$3" > "$TMP/tokbody"
  curl -s -o "$TMP/body" -D "$TMP/headers" -w "%{http_code}" -X POST "$INTERNAL_URL/internal/auth/token" -H "Content-Type: application/json" \
       -H "X-Forwarded-For: $(newip)" --data-binary @"$TMP/tokbody" > "$TMP/tokstatus"
  jget data.access_token
}
T_READ="$(mint "$READ_ID" "$READ_SEC" "users:read")"
T_STATW="$(mint "$STAT_ID" "$STAT_SEC" "users:status:write")"
T_CARE_READ="$(mint "$CARE_ID" "$CARE_SEC" "users:read")"
T_CARE_STAT="$(mint "$CARE_ID" "$CARE_SEC" "users:status:write")"
T_CARE_CONTACT="$(mint "$CARE_ID" "$CARE_SEC" "users:contact:read")"
T_CARE_ALL="$(mint "$CARE_ID" "$CARE_SEC" "users:read users:status:write users:contact:read")"
for v in T_READ T_STATW T_CARE_READ T_CARE_STAT T_CARE_CONTACT T_CARE_ALL; do
  [ -n "${!v}" ] || { echo "service token fixture failed for $v (token endpoint rate limit or bad migration state?)"; exit 2; }
done

TOKEN=""; LAST_COOKIE=""
login() { # login <tag> -> TOKEN, LAST_COOKIE (retries on the 20/min per-IP login limiter)
  local i
  for i in 1 2 3 4; do
    LR="none"; LM="POST"; LP="/api/auth/login"; RID="$(uuid)"
    STATUS="$(curl -s -o "$TMP/body" -D "$TMP/headers" -w "%{http_code}" -X POST "$PUBLIC_URL/api/auth/login" \
        -H "Content-Type: application/json" -H "X-Request-Id: $RID" --data "{\"email\":\"$(em "$1")\",\"password\":\"$PW\"}" | tr -d '\r')"
    [ "$STATUS" = "429" ] || break
    sleep 20
  done
  TOKEN="$(jget data.accessToken)"
  LAST_COOKIE="$({ grep -i '^set-cookie: vcare_rt=' "$TMP/headers" || true; } | head -1 | sed -E 's/^[Ss]et-[Cc]ookie: (vcare_rt=[^;]*).*/\1/' | tr -d '\r')"
}
login patient; U_PAT="$TOKEN"
login admin;   U_ADM="$TOKEN"
login docuser; U_DOC="$TOKEN"
for v in U_PAT U_ADM U_DOC; do [ -n "${!v}" ] || { echo "user login fixture failed for $v"; exit 2; }; done
echo "tokens obtained: 6 service tokens, 3 user tokens (values never printed)"

pj() { python -c 'import json,sys;print(json.dumps({"status":sys.argv[1],"reason":sys.argv[3],"actorUserId":int(sys.argv[2])}))' "$1" "$2" "${3:-$REASON}" | tr -d '\r'; }

# ============================================================================= GET /internal/users (Case 2)
echo; echo "== GET /internal/users (Case 2)"
IDS="$PAT_ID,$DOC_ID,$ABSENT_ID,$PD_ID,$DD_ID"
ireq none GET "/internal/users?ids=$IDS" - "";                       check "no token" 401 ServiceTokenRequired
ireq garbage GET "/internal/users?ids=$IDS" "garbage.token.value" ""; check "malformed token" 401 ServiceTokenRequired
ireq patient-user GET "/internal/users?ids=$IDS" "$U_PAT" "";        check "patient user token" 401 ServiceTokenRequired
ireq doctor-user GET "/internal/users?ids=$IDS" "$U_DOC" "";         check "doctor user token" 401 ServiceTokenRequired
ireq admin-user GET "/internal/users?ids=$IDS" "$U_ADM" "";          check "admin user token (even an admin's)" 401 ServiceTokenRequired
ireq admin-user+forged GET "/internal/users?ids=$IDS" "$U_ADM" "" -H "X-User-Id: $ADM_ID" -H "X-Role: admin" -H "X-Forwarded-User: admin"
check "user token + forged X-User-Id/X-Role headers" 401 ServiceTokenRequired
ireq svc:status-only GET "/internal/users?ids=$IDS" "$T_CARE_STAT" ""; check "scope users:status:write is not users:read" 403 InsufficientScope
ireq svc:contact-only GET "/internal/users?ids=$IDS" "$T_CARE_CONTACT" ""; check "scope users:contact:read is not users:read" 403 InsufficientScope
ireq svc:status-only GET "/internal/users" "$T_CARE_STAT" "";        check "scope checked before validation (missing ids)" 403 InsufficientScope

ireq svc:read GET "/internal/users?ids=$IDS" "$T_READ" "";           check "happy path: qa client with users:read" 200
assert "omits unknown, soft-deleted patient and soft-deleted doctor" "$(dids)" "$(sorted_ids "$PAT_ID" "$DOC_ID")"
assert "summary keys are exactly the contract UserSummary" "$(dkeys data.0)" "avatarUrl,fullName,id,locale,role,status,timezone"
assert "no email in body" "$(grep -c 'example.test' "$TMP/body" || true)" "0"
assert "no phone in body" "$(grep -cE '0100123|0100456|phone' "$TMP/body" || true)" "0"
assert "no hash/secret key in body" "$(grep -ciE 'hash|password|token|secret' "$TMP/body" || true)" "0"
assert "X-Request-Id echoed" "$(header x-request-id)" "$RID"
assert "avatarUrl is null (not absent) for a user without one" "$(jget data.0.avatarUrl)" ""
ireq svc:care-read GET "/internal/users?ids=$ABSENT_ID,$PD_ID" "$T_CARE_READ" ""; check "all ids unknown or deleted" 200
assert "all-unknown: data is []" "$(jget data)" "[]"
ireq svc:care-read GET "/internal/users?ids=$PAT_ID,$PAT_ID" "$T_CARE_READ" ""; check "duplicate ids are collapsed (D-9)" 200
assert "duplicate ids: one row" "$(dids)" "$PAT_ID"
ireq svc:care-read GET "/internal/users?ids=$(seq -s, 1 100)" "$T_CARE_READ" ""; check "exactly 100 ids" 200
assert_match "100 ids: at most 100 rows" "$(jget data | python -c 'import json,sys;print(len(json.load(sys.stdin)))' | tr -d '\r')" '^([0-9]|[1-9][0-9]|100)$'
ireq svc:care-read GET "/internal/users?ids=$(seq -s, 1 101)" "$T_CARE_READ" ""; check "101 ids -> cap" 400 ValidationFailed
assert "101 ids: error.details[0].field is ids" "$(jget error.details.0.field)" "ids"
ireq svc:care-read GET "/internal/users?ids=$(python -c "print(','.join(['1']*101))")" "$T_CARE_READ" ""; check "101 duplicate entries (cap counts as sent)" 400 ValidationFailed
for bad in "" "?ids=" "?ids=1,,2" "?ids=abc" "?ids=0" "?ids=-1" "?ids=01" "?ids=1.5" "?ids=1,2," "?ids=1&ids=2" "?ids=1&foo=bar" "?ids=9007199254740993" "?ids=%20"; do
  ireq svc:care-read GET "/internal/users$bad" "$T_CARE_READ" ""; check "bad ids: '${bad:-<no query>}'" 400 ValidationFailed
done
ireq svc:read GET "/internal/users?ids=$PAT_ID" "$T_READ" "" -H "Idempotency-Key: $(uuid)"; check "Idempotency-Key ignored on GET" 200

# ============================================================================= GET /internal/users/contacts (Case 5)
echo; echo "== GET /internal/users/contacts (Case 5)"
CIDS="$PAT_ID,$DOC_ID,$ABSENT_ID,$PD_ID"
ireq none GET "/internal/users/contacts?ids=$CIDS" - "";                      check "no token" 401 ServiceTokenRequired
ireq patient-user GET "/internal/users/contacts?ids=$CIDS" "$U_PAT" "";       check "patient user token" 401 ServiceTokenRequired
ireq doctor-user GET "/internal/users/contacts?ids=$CIDS" "$U_DOC" "";        check "doctor user token" 401 ServiceTokenRequired
ireq admin-user GET "/internal/users/contacts?ids=$CIDS" "$U_ADM" "";         check "admin user token" 401 ServiceTokenRequired
ireq svc:read GET "/internal/users/contacts?ids=$CIDS" "$T_READ" "";          check "qa client with users:read only" 403 InsufficientScope
ireq svc:care-read GET "/internal/users/contacts?ids=$CIDS" "$T_CARE_READ" ""; check "care-service token scoped users:read" 403 InsufficientScope
ireq svc:care-stat GET "/internal/users/contacts?ids=$CIDS" "$T_CARE_STAT" ""; check "care-service token scoped users:status:write" 403 InsufficientScope
ireq svc:read GET "/internal/users/contacts" "$T_READ" "";                    check "scope checked before validation (missing ids)" 403 InsufficientScope
ireq svc:care-contact GET "/internal/users/contacts?ids=$CIDS" "$T_CARE_CONTACT" ""; check "happy path: care-service with users:contact:read" 200
assert "Cache-Control: no-store" "$(header cache-control)" "no-store"
assert "X-Request-Id echoed" "$(header x-request-id)" "$RID"
assert "omits unknown and soft-deleted ids" "$(dids)" "$(sorted_ids "$PAT_ID" "$DOC_ID")"
assert "contact keys are exactly the contract UserContact (no phone)" "$(dkeys data.0)" "email,fullName,id,locale,status"
assert "email returned for the patient" "$(jget data | python -c "import json,sys;print([u['email'] for u in json.load(sys.stdin) if u['id']==$PAT_ID][0])" | tr -d '\r' | sed -E 's/.*@/@/')" "@example.test"
assert "no phone value or key in body" "$(grep -cE '0100123|0100456|phone' "$TMP/body" || true)" "0"
assert "no hash/secret key in body" "$(grep -ciE 'hash|password|token|secret' "$TMP/body" || true)" "0"
ireq svc:care-all GET "/internal/users/contacts?ids=$(seq -s, 1 100)" "$T_CARE_ALL" ""; check "exactly 100 ids" 200
ireq svc:care-all GET "/internal/users/contacts?ids=$(seq -s, 1 101)" "$T_CARE_ALL" ""; check "101 ids -> cap" 400 ValidationFailed
for bad in "" "?ids=" "?ids=1,,2" "?ids=abc" "?ids=0" "?ids=1&ids=2" "?ids=1&foo=bar"; do
  ireq svc:care-all GET "/internal/users/contacts$bad" "$T_CARE_ALL" ""; check "bad ids: '${bad:-<no query>}'" 400 ValidationFailed
done
echo "-- care-service only (ADR 0024)"
assert "DB refuses users:contact:read on a non-care client (chk_service_clients_contact_scope_care_only)" \
  "$(psql "$DATABASE_URL" -tAqc "INSERT INTO service_clients (client_id,name,client_secret_hash,allowed_scopes,allowed_audiences,is_active,created_at,updated_at) VALUES ('qa-iu-${RUN}-bad','x','\$argon2id\$x','{users:read,users:contact:read}','{vcare-identity}',true,now(),now())" 2>&1 | grep -c 'chk_service_clients_contact_scope_care_only' || true)" "1"
printf '{"grant_type":"client_credentials","client_id":"%s","client_secret":"%s","scope":"users:contact:read","audience":"vcare-identity"}' "$READ_ID" "$READ_SEC" > "$TMP/tokbody"
LR=none; LM=POST; LP=/internal/auth/token
STATUS="$(curl -s -o "$TMP/body" -D "$TMP/headers" -w "%{http_code}" -X POST "$INTERNAL_URL/internal/auth/token" -H "Content-Type: application/json" -H "X-Forwarded-For: $(newip)" --data-binary @"$TMP/tokbody" | tr -d '\r')"
check "token endpoint refuses users:contact:read to a non-care client" 403 InsufficientScope

# ============================================================================= PATCH /internal/users/{id}/status
echo; echo "== PATCH /internal/users/{id}/status: authn, scope, validation order"
B="$(pj active "$ADM_ID")"
ireq none PATCH "/internal/users/$D1_ID/status" - "$B";                       check "no token" 401 ServiceTokenRequired
ireq garbage PATCH "/internal/users/$D1_ID/status" "garbage.token.value" "$B"; check "malformed token" 401 ServiceTokenRequired
ireq patient-user PATCH "/internal/users/$D1_ID/status" "$U_PAT" "$B";        check "patient user token" 401 ServiceTokenRequired
ireq doctor-user PATCH "/internal/users/$D1_ID/status" "$U_DOC" "$B";         check "doctor user token" 401 ServiceTokenRequired
ireq admin-user PATCH "/internal/users/$D1_ID/status" "$U_ADM" "$B";          check "admin user token" 401 ServiceTokenRequired
ireq admin-user+forged PATCH "/internal/users/$D1_ID/status" "$U_ADM" "$B" -H "X-User-Id: $ADM_ID" -H "X-Role: admin"
check "user token + forged identity headers" 401 ServiceTokenRequired
ireq svc:read PATCH "/internal/users/$D1_ID/status" "$T_READ" "$B";           check "users:read token" 403 InsufficientScope
ireq svc:care-contact PATCH "/internal/users/$D1_ID/status" "$T_CARE_CONTACT" "$B"; check "users:contact:read token" 403 InsufficientScope
ireq svc:read PATCH "/internal/users/abc/status" "$T_READ" '{"bad":1}';       check "scope checked before path/body validation" 403 InsufficientScope
ireq svc:read PATCH "/internal/users/$ABSENT_ID/status" "$T_READ" "$B";       check "scope checked before target lookup (absent id)" 403 InsufficientScope
assert "no write from refused calls (d1 still pending, 0 history)" "$(ustat "$D1_ID")/$(hist "$D1_ID")" "pending/0"

echo; echo "== PATCH status: validation (400 before any lookup)"
V() { ireq svc:status PATCH "/internal/users/$1/status" "$T_CARE_STAT" "$2"; check "$3" 400 ValidationFailed; }
V abc "$B" "id=abc"
V 0 "$B" "id=0"
V -1 "$B" "id=-1"
V 01 "$B" "id=01 (leading zero)"
V "$D1_ID" '{"status":"active","reason":"qa"}' "missing actorUserId"
V "$D1_ID" '{"reason":"qa","actorUserId":1}' "missing status"
V "$D1_ID" '{"status":"active","actorUserId":1}' "missing reason"
V "$D1_ID" '{"status":"bogus","reason":"qa","actorUserId":1}' "status outside the four values"
V "$D1_ID" '{"status":"active","reason":"","actorUserId":1}' "empty reason"
V "$D1_ID" '{"status":"active","reason":"   ","actorUserId":1}' "blank reason"
V "$D1_ID" "{\"status\":\"active\",\"reason\":\"$(python -c 'print("x"*501)')\",\"actorUserId\":1}" "reason 501 chars"
V "$D1_ID" '{"status":"active","reason":"qa","actorUserId":"1"}' "actorUserId as a string"
V "$D1_ID" '{"status":"active","reason":"qa","actorUserId":0}' "actorUserId 0"
V "$D1_ID" '{"status":"active","reason":"qa","actorUserId":1.5}' "actorUserId 1.5"
V "$D1_ID" '{"status":"active","reason":"qa","actorUserId":1,"role":"admin"}' "unknown body field"
V "$D1_ID" '{not json' "malformed JSON"
V "$D1_ID" '' "empty body"
V "$ABSENT_ID" '{"status":"bogus"}' "invalid body on an absent target is 400, not 404"
V "$PAT_ID" '{"status":"bogus"}' "invalid body on a patient target is 400, not 403"
assert "validation failures wrote nothing (d1 pending, 0 history, patient active)" "$(ustat "$D1_ID")/$(hist "$D1_ID")/$(ustat "$PAT_ID")" "pending/0/active"

echo; echo "== PATCH status: 404 (checked first) and ADR 0025 non-doctor targets"
ireq svc:status PATCH "/internal/users/$ABSENT_ID/status" "$T_CARE_STAT" "$B";   check "absent target" 404 NotFound
ireq svc:status PATCH "/internal/users/$DD_ID/status" "$T_CARE_STAT" "$B";       check "soft-deleted doctor" 404 NotFound
ireq svc:status PATCH "/internal/users/$PD_ID/status" "$T_CARE_STAT" "$B";       check "soft-deleted patient (404 before the role check)" 404 NotFound
login patient; P_COOKIE="$LAST_COOKIE"   # extra live family on the patient target
PAT_LIVE="$(live "$PAT_ID")"; ADM_LIVE="$(live "$ADM_ID")"; PAT_UPD="$(uupd "$PAT_ID")"; ADM_UPD="$(uupd "$ADM_ID")"
for st in active suspended rejected pending; do
  ireq svc:status PATCH "/internal/users/$PAT_ID/status" "$T_CARE_STAT" "$(pj "$st" "$ADM_ID")"; check "patient target, status=$st" 403 Forbidden
  ireq svc:status PATCH "/internal/users/$ADM_ID/status" "$T_CARE_STAT" "$(pj "$st" "$ADM_ID")"; check "admin target (the actor itself), status=$st" 403 Forbidden
done
assert "patient: status unchanged, updated_at unchanged, no history" "$(ustat "$PAT_ID")/$([ "$(uupd "$PAT_ID")" = "$PAT_UPD" ] && echo same)/$(hist "$PAT_ID")" "active/same/0"
assert "admin: status unchanged, updated_at unchanged, no history" "$(ustat "$ADM_ID")/$([ "$(uupd "$ADM_ID")" = "$ADM_UPD" ] && echo same)/$(hist "$ADM_ID")" "active/same/0"
assert "patient: refresh tokens not revoked ($PAT_LIVE live before)" "$(live "$PAT_ID")" "$PAT_LIVE"
assert "admin: refresh tokens not revoked" "$(live "$ADM_ID")" "$ADM_LIVE"
RID="$(uuid)"; LR=patient; LM=POST; LP=/api/auth/refresh
STATUS="$(curl -s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' -X POST "$PUBLIC_URL/api/auth/refresh" -H "Cookie: $P_COOKIE" -H "X-Request-Id: $RID" | tr -d '\r')"
check "patient's refresh still works after the refused calls" 200

echo; echo "== Case 1: pending doctor -> active (d1), actor and trace recorded"
login d1; D1_COOKIE="$LAST_COOKIE"
assert "d1 pending can log in (live token)" "$(live "$D1_ID")" "1"
ireq svc:care-stat PATCH "/internal/users/$D1_ID/status" "$T_CARE_STAT" "$(pj active "$ADM_ID")" ; C1_RID="$RID"; check "pending -> active" 200
C1_UPD="$(jget data.updatedAt)"
assert "response data keys are exactly id,status,updatedAt" "$(dkeys data)" "id,status,updatedAt"
assert "response data.status" "$(jget data.status)" "active"
assert "response data.id" "$(jget data.id)" "$D1_ID"
assert "X-Request-Id echoed" "$(header x-request-id)" "$C1_RID"
assert "users row is active" "$(ustat "$D1_ID")" "active"
assert "one history row: pending->active, actor_user_id, actor_service=care-service, request_id=caller's" \
  "$(psql_q "SELECT count(*)||','||bool_and(from_status='pending' AND to_status='active' AND actor_user_id=$ADM_ID AND actor_service='care-service' AND request_id='$C1_RID')||','||bool_and(reason='$REASON') FROM user_status_changes WHERE user_id=$D1_ID")" "1,true,true"
assert "entering active revoked nothing (token still live)" "$(live "$D1_ID")" "1"
ireq svc:care-stat PATCH "/internal/users/$D1_ID/status" "$T_CARE_STAT" "$(pj active "$ADM_ID")"; check "repeat active (no-op)" 200
assert "repeat active: still 1 history row" "$(hist "$D1_ID")" "1"
assert "repeat active: updatedAt unchanged" "$(jget data.updatedAt)" "$C1_UPD"
ireq svc:care-stat PATCH "/internal/users/$D1_ID/status" "$T_CARE_STAT" "$(pj active "$ADM_ID")" -H "Idempotency-Key: $(uuid)"; check "Idempotency-Key ignored on PATCH (no 422/409)" 200

echo; echo "== Case 1: pending -> rejected revokes everything; rejected may sign in (d2)"
login d2; login d2; D2_OLD="$LAST_COOKIE"
assert "d2 has 2 live families" "$(live "$D2_ID")" "2"
ireq svc:care-stat PATCH "/internal/users/$D2_ID/status" "$T_CARE_STAT" "$(pj rejected "$ADM_ID")"; check "pending -> rejected" 200
assert "all families revoked, reason status_changed" "$(live "$D2_ID")/$(psql_q "SELECT string_agg(DISTINCT revoked_reason, ',') FROM refresh_tokens WHERE user_id=$D2_ID")" "0/status_changed"
assert "one history row pending->rejected" "$(psql_q "SELECT count(*)||','||bool_and(from_status='pending' AND to_status='rejected') FROM user_status_changes WHERE user_id=$D2_ID")" "1,true"
RID="$(uuid)"; LR=doctor; LM=POST; LP=/api/auth/refresh
STATUS="$(curl -s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' -X POST "$PUBLIC_URL/api/auth/refresh" -H "Cookie: $D2_OLD" -H "X-Request-Id: $RID" | tr -d '\r')"
check "old cookie after rejection is dead" 401 RefreshTokenInvalid
login d2; check "rejected doctor can log in (ADR 0004)" 200; D2_NEW="$LAST_COOKIE"
assert "login token carries status rejected" "$(printf '%s' "$TOKEN" | cut -d. -f2 | python -c 'import sys,base64,json;s=sys.stdin.read().strip();s+="="*(-len(s)%4);print(json.loads(base64.urlsafe_b64decode(s))["status"])' | tr -d '\r')" "rejected"
RID="$(uuid)"; STATUS="$(curl -s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' -X POST "$PUBLIC_URL/api/auth/refresh" -H "Cookie: $D2_NEW" -H "X-Request-Id: $RID" | tr -d '\r')"
check "rejected doctor can refresh" 200
D2_LIVE="$(live "$D2_ID")"
ireq svc:care-stat PATCH "/internal/users/$D2_ID/status" "$T_CARE_STAT" "$(pj rejected "$ADM_ID")"; check "repeat rejected (no-op)" 200
assert "repeat rejected: live token NOT revoked (ADR 0004, D-5)" "$(live "$D2_ID")" "$D2_LIVE"
assert "repeat rejected: still 1 history row" "$(hist "$D2_ID")" "1"
ireq svc:care-stat PATCH "/internal/users/$D2_ID/status" "$T_CARE_STAT" "$(pj pending "$ADM_ID")"; check "rejected -> pending (re-open)" 200
assert "pending revoked nothing; 2 history rows" "$(live "$D2_ID")/$(hist "$D2_ID")" "$D2_LIVE/2"
ireq svc:care-stat PATCH "/internal/users/$D2_ID/status" "$T_CARE_STAT" "$(pj pending "$ADM_ID")"; check "repeat pending (no-op)" 200
assert "repeat pending: still 2 history rows" "$(hist "$D2_ID")" "2"

echo; echo "== Case 3: active -> suspended revokes all sessions (d3)"
login d3; D3_C1="$LAST_COOKIE"; login d3; D3_C2="$LAST_COOKIE"
assert "d3 has 2 live families" "$(live "$D3_ID")" "2"
ireq svc:care-stat PATCH "/internal/users/$D3_ID/status" "$T_CARE_STAT" "$(pj suspended "$ADM_ID")"; check "active -> suspended" 200
S_UPD="$(jget data.updatedAt)"
assert "response status" "$(jget data.status)" "suspended"
assert "all families revoked, reason status_changed" "$(live "$D3_ID")/$(psql_q "SELECT string_agg(DISTINCT revoked_reason, ',') FROM refresh_tokens WHERE user_id=$D3_ID")" "0/status_changed"
assert "one history row active->suspended" "$(psql_q "SELECT count(*)||','||bool_and(from_status='active' AND to_status='suspended' AND actor_service='care-service') FROM user_status_changes WHERE user_id=$D3_ID")" "1,true"
for c in "$D3_C1" "$D3_C2"; do
  RID="$(uuid)"; LR=doctor; LM=POST; LP=/api/auth/refresh
  STATUS="$(curl -s -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' -X POST "$PUBLIC_URL/api/auth/refresh" -H "Cookie: $c" -H "X-Request-Id: $RID" | tr -d '\r')"
  assert_match "refresh with a pre-suspension cookie fails" "$STATUS $(jget error.code)" '^(401 RefreshTokenInvalid|403 AccountSuspended)$'
done
login d3; check "login refused for suspended doctor" 403 AccountSuspended
ireq svc:care-stat PATCH "/internal/users/$D3_ID/status" "$T_CARE_STAT" "$(pj suspended "$ADM_ID")"; check "repeat suspended (no-op)" 200
assert "repeat suspended: updatedAt unchanged, still 1 history row" "$([ "$(jget data.updatedAt)" = "$S_UPD" ] && echo same)/$(hist "$D3_ID")" "same/1"

echo; echo "== Case 3: repeat suspended still revokes a live token (d5, token present while status already suspended)"
login d5
psql_q "UPDATE users SET status='suspended' WHERE id=$D5_ID" >/dev/null     # status set without revocation or history
assert "setup: suspended with 1 live token, 0 history" "$(ustat "$D5_ID")/$(live "$D5_ID")/$(hist "$D5_ID")" "suspended/1/0"
ireq svc:care-stat PATCH "/internal/users/$D5_ID/status" "$T_CARE_STAT" "$(pj suspended "$ADM_ID")"; check "repeat suspended on a suspended doctor with a live token" 200
assert "live token revoked, no history row written" "$(live "$D5_ID")/$(hist "$D5_ID")" "0/0"

echo; echo "== Case 4: suspended -> active (d3)"
ireq svc:care-stat PATCH "/internal/users/$D3_ID/status" "$T_CARE_STAT" "$(pj active "$ADM_ID")"; check "suspended -> active (reinstatement)" 200
R_UPD="$(jget data.updatedAt)"
assert "response status" "$(jget data.status)" "active"
assert "2 history rows; last is suspended->active" "$(hist "$D3_ID")/$(psql_q "SELECT from_status||'>'||to_status FROM user_status_changes WHERE user_id=$D3_ID ORDER BY id DESC LIMIT 1")" "2/suspended>active"
assert "old tokens stay revoked (nothing revived)" "$(live "$D3_ID")" "0"
login d3; check "doctor can sign in again" 200
ireq svc:care-stat PATCH "/internal/users/$D3_ID/status" "$T_CARE_STAT" "$(pj active "$ADM_ID")"; check "repeat active (retried Case 4)" 200
assert "repeat active: updatedAt unchanged, still 2 history rows, new login token kept" "$([ "$(jget data.updatedAt)" = "$R_UPD" ] && echo same)/$(hist "$D3_ID")/$(live "$D3_ID")" "same/2/1"
preq admin PATCH "/api/users/$D3_ID/status" "$U_ADM" '{"status":"suspended","reason":"qa"}'; check "public admin route still refuses a doctor target (ADR 0012)" 403 Forbidden

echo; echo "== Transition matrix on a scratch doctor (dx): all 16 ordered pairs"
STATES=(pending active rejected suspended)
allowed() { case "$1>$2" in pending\>active|pending\>rejected|rejected\>pending|active\>suspended|suspended\>active) return 0;; *) return 1;; esac; }
EXPECT_ROWS=0
for from in "${STATES[@]}"; do
  for to in "${STATES[@]}"; do
    psql_q "UPDATE users SET status='$from' WHERE id=$DX_ID" >/dev/null
    before="$(hist "$DX_ID")"
    ireq svc:status-qa PATCH "/internal/users/$DX_ID/status" "$T_STATW" "$(pj "$to" "$ADM_ID")"
    if [ "$from" = "$to" ]; then
      check "$from -> $to (same status, no-op)" 200; assert "$from -> $to: status stays, no history row" "$(ustat "$DX_ID")/$(( $(hist "$DX_ID") - before ))" "$from/0"
    elif allowed "$from" "$to"; then
      check "$from -> $to (allowed)" 200; EXPECT_ROWS=$((EXPECT_ROWS+1))
      assert "$from -> $to: status moved, 1 history row" "$(ustat "$DX_ID")/$(( $(hist "$DX_ID") - before ))" "$to/1"
    else
      check "$from -> $to (invalid)" 409 InvalidStatusTransition
      assert "$from -> $to: status stays, no history row" "$(ustat "$DX_ID")/$(( $(hist "$DX_ID") - before ))" "$from/0"
    fi
  done
done
assert "matrix wrote exactly one history row per real change" "$(hist "$DX_ID")" "$EXPECT_ROWS"
assert "actor_service is the token sub (qa client, not a header)" "$(psql_q "SELECT string_agg(DISTINCT actor_service, ',') FROM user_status_changes WHERE user_id=$DX_ID")" "$STAT_ID"
# a 409 must not revoke: put dx at active with a live token, ask for rejected
psql_q "UPDATE users SET status='active' WHERE id=$DX_ID" >/dev/null
psql_q "INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($DX_ID, gen_random_uuid(), md5(random()::text) || md5(random()::text), now() + interval '1 day')" >/dev/null
DXL="$(live "$DX_ID")"
ireq svc:status-qa PATCH "/internal/users/$DX_ID/status" "$T_STATW" "$(pj rejected "$ADM_ID")"; check "active -> rejected (409) with a live token present" 409 InvalidStatusTransition
assert "409 revoked nothing (live token count unchanged; $DXL before)" "$(live "$DX_ID")" "$DXL"

echo; echo "== actorUserId is data, never authority (dy)"
ireq svc:care-stat PATCH "/internal/users/$DY_ID/status" "$T_CARE_STAT" "$(pj suspended "$ABSENT_ACTOR")"; check "unknown actorUserId -> still 200" 200
assert "unknown actor stored as NULL, actor_service kept, request_id kept" \
  "$(psql_q "SELECT (actor_user_id IS NULL)||','||actor_service||','||(request_id IS NOT NULL) FROM user_status_changes WHERE user_id=$DY_ID ORDER BY id DESC LIMIT 1")" "true,care-service,true"
ireq svc:care-stat PATCH "/internal/users/$DY_ID/status" "$T_CARE_STAT" "$(pj active "$ACTOR_DEL_ID")"; check "soft-deleted actorUserId -> 200" 200
assert "soft-deleted actor id recorded as is" "$(psql_q "SELECT actor_user_id FROM user_status_changes WHERE user_id=$DY_ID ORDER BY id DESC LIMIT 1")" "$ACTOR_DEL_ID"
ireq svc:care-stat PATCH "/internal/users/$DY_ID/status" "$T_CARE_STAT" "$(pj suspended "$PAT_ID")"; check "patient actorUserId (no role check on actor) -> 200" 200
assert "patient actor id recorded as is; 3 history rows" "$(psql_q "SELECT actor_user_id FROM user_status_changes WHERE user_id=$DY_ID ORDER BY id DESC LIMIT 1")/$(hist "$DY_ID")" "$PAT_ID/3"

# ============================================================================= boundaries
echo; echo "== boundaries and request id"
preq none GET "/internal/users?ids=$PAT_ID" "$T_CARE_ALL" "";                 check "internal route is not served on the public listener" 404 NotFound
preq none PATCH "/internal/users/$D1_ID/status" "$T_CARE_ALL" "$(pj active "$ADM_ID")"; check "internal status route not on the public listener" 404 NotFound
preq none GET "/api/users" "$T_CARE_ALL" "";                                  check "service token on a public user route" 401 Unauthorized
LR=svc:care-all; LM=GET; LP="/internal/users?ids={id}"
curl -s -o "$TMP/body" -D "$TMP/headers" "$INTERNAL_URL/internal/users?ids=$PAT_ID" -H "Authorization: Bearer $T_CARE_ALL" -H "X-Request-Id: not-a-uuid" >/dev/null
assert_match "invalid X-Request-Id replaced by a generated UUID" "$(header x-request-id)" '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
assert "every request() call echoed its X-Request-Id (mismatches)" "$RID_BAD" "0"

# ============================================================================= log hygiene (optional)
if [ -n "$SERVER_LOG" ] && [ -f "$SERVER_LOG" ]; then
  echo; echo "== server log hygiene ($SERVER_LOG)"
  LR=log; LM=-; LP=-
  assert "no free-text reason in the log (BR-16, ADR 0021)" "$(grep -cF "$REASON" "$SERVER_LOG" || true)" "0"
  assert "no e-mail address in the log" "$(grep -c '@example.test' "$SERVER_LOG" || true)" "0"
  assert "no phone number in the log" "$(grep -cE '0100123|0100456' "$SERVER_LOG" || true)" "0"
  assert "no JWT-shaped string in the log" "$(grep -cE 'eyJ[A-Za-z0-9_-]{10,}\.' "$SERVER_LOG" || true)" "0"
  assert "no Authorization/Bearer text in the log" "$(grep -ciE 'authorization|bearer ' "$SERVER_LOG" || true)" "0"
  assert "status_change_actor_unknown logged for the unknown actor" "$([ "$(grep -c '"status_change_actor_unknown"' "$SERVER_LOG" || true)" -ge 1 ] && echo yes)" "yes"
  assert "user_status_changed logged" "$([ "$(grep -c '"user_status_changed"' "$SERVER_LOG" || true)" -ge 1 ] && echo yes)" "yes"
  # spec.md section 3.2 / 7 names this event `contacts_looked_up`; the code emits `internal_contacts_read` (docs drift)
  assert "internal_contacts_read logged with counts only (requested/returned)" "$(grep '"internal_contacts_read"' "$SERVER_LOG" | head -1 | grep -c '"requested":[0-9]*,"returned":[0-9]*' || true)" "1"
  assert "no error-level line during the run" "$(grep -c '"level":"error"' "$SERVER_LOG" || true)" "0"
else
  echo; echo "SERVER_LOG not set or not a file: log hygiene section SKIPPED"
fi

echo
echo "== summary: $PASS pass / $FAIL fail ($N checks; X-Request-Id echoed on $RID_OK requests)"
[ "$FAIL" = 0 ]
