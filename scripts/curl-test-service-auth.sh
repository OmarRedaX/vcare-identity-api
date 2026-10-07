#!/usr/bin/env bash
# Manual QA for the `service-auth` module of identity-service (docs/service-auth/manual-qa.md).
#
# Drives POST /internal/auth/token (JSON and form), the two /internal/health/* probes, the provisioning and seed
# scripts, secret rotation, the rate limiters, and the "internal is not public / user token is not a service token"
# boundaries with CURL, and compares status, error.code, shape, headers and the echoed X-Request-Id with
# contracts/openapi.yaml and docs/service-auth/spec.md.
#
# Usage (server already running against a migrated database, from the repo root, using node_modules/.bin/tsx):
#   INTERNAL_TRUST_PROXY_HOPS=1 npx tsx src/server.ts > server.log 2>&1 &      # see "Server setup" below
#   DATABASE_URL=postgres://identity:identity@localhost:5432/vcare_identity_test SERVER_LOG=server.log \
#     ./scripts/curl-test-service-auth.sh
#   PUBLIC_URL=http://localhost:3000 INTERNAL_URL=http://localhost:3100 REDIS_DB=2 ./scripts/curl-test-service-auth.sh
#
# Server setup the script assumes: INTERNAL_TRUST_PROXY_HOPS=1 so that each request can carry its own
# X-Forwarded-For and the 30/min per-IP limiter does not make the run self-throttling. With 0 hops every curl call
# shares 127.0.0.1 and only 30 token requests per minute are possible. The script cannot detect the setting, so the
# per-IP section asserts the 31st request from one forwarded IP is 429.
#
# Requirements: bash, curl, python 3, psql, node + npx tsx (repo root). The server log (SERVER_LOG) is optional but
# strongly recommended: when set, the script greps it for every secret, hash and token it ever saw.
#
# How it runs without secrets:
#   * Service clients are created by scripts/provision-service-client.ts (SQL applied with psql -f) and by
#     scripts/seed-service-client.ts; their secrets are held in shell variables and never printed.
#   * Client ids are unique per run (qa-...-<run>) so the script is idempotent; rows are left in place.
#   * User fixtures (patient, doctor, admin) are SQL inserts with @example.test emails and a per-run password; tokens
#     come from POST /api/auth/login on the public listener.
# Exit status is non-zero when any check fails. Nothing token-, cookie-, secret- or email-shaped is echoed.
set -uo pipefail

PUBLIC_URL="${PUBLIC_URL:-http://localhost:3000}"
INTERNAL_URL="${INTERNAL_URL:-http://localhost:3100}"
DATABASE_URL="${DATABASE_URL:-postgres://identity:identity@localhost:5432/vcare_identity_test}"
SERVER_LOG="${SERVER_LOG:-}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

RUN="$(date +%s)${RANDOM}"
PW="QaPass-${RUN}-zz9!"
PASS=0; FAIL=0; N=0; RID_OK=0; RID_BAD=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
: > "$TMP/needles"   # every secret / token / hash seen in this run, one per line, for the log grep

uuid() { python -c "import uuid;print(uuid.uuid4())" | tr -d '\r'; }
psql_q() { psql "$DATABASE_URL" -tAqc "$1" | tr -d '\r'; }
header() { { grep -i "^$1:" "$TMP/headers" || true; } | head -1 | cut -d" " -f2- | tr -d "\r"; }
needle() { [ -n "$1" ] && printf '%s\n' "$1" >> "$TMP/needles"; return 0; }
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
# error envelope without the per-request id, for "identical response" comparisons
norm_err() { python -c '
import json,sys
d=json.load(open(sys.argv[1]))
d.get("error",{}).pop("requestId",None)
print(json.dumps(d,sort_keys=True))' "$TMP/body" | tr -d '\r'; }
newip() { echo "10.$((RANDOM % 250)).$((RANDOM % 250)).$((1 + RANDOM % 250))"; }

STATUS=""; RID=""; IPFIX=""
# req BASE METHOD PATH TOKEN [BODY-JSON] [extra curl args...]   (TOKEN "-" = no Authorization header)
req() {
  local base="$1" method="$2" path="$3" token="$4" body="${5:-}"; shift 5 || shift $#
  RID="$(uuid)"
  local ip="${IPFIX:-$(newip)}"
  local args=(-s -o "$TMP/body" -D "$TMP/headers" -w "%{http_code}" -X "$method" "$base$path"
              -H "X-Request-Id: $RID" -H "X-Forwarded-For: $ip")
  [ "$token" != "-" ] && args+=(-H "Authorization: Bearer $token")
  if [ -n "$body" ]; then args+=(-H "Content-Type: application/json" --data "$body"); fi
  args+=("$@")
  STATUS="$(curl "${args[@]}" | tr -d '\r')"
  if [ "$(header x-request-id)" = "$RID" ]; then RID_OK=$((RID_OK+1)); else RID_BAD=$((RID_BAD+1)); fi
}
# tokreq JSON-body [extra curl args]  -> POST /internal/auth/token
tokreq() { local body="$1"; shift; req "$INTERNAL_URL" POST /internal/auth/token - "$body" "$@"; }
# formreq "urlencoded body" [extra curl args]
formreq() {
  local data="$1"; shift
  RID="$(uuid)"
  STATUS="$(curl -s -o "$TMP/body" -D "$TMP/headers" -w "%{http_code}" -X POST "$INTERNAL_URL/internal/auth/token" \
            -H "X-Request-Id: $RID" -H "X-Forwarded-For: ${IPFIX:-$(newip)}" \
            -H "Content-Type: application/x-www-form-urlencoded" --data "$data" "$@" | tr -d '\r')"
  if [ "$(header x-request-id)" = "$RID" ]; then RID_OK=$((RID_OK+1)); else RID_BAD=$((RID_BAD+1)); fi
}
body_json() { # body_json client_id secret scope audience [grant_type]
  python -c '
import json,sys
print(json.dumps({"grant_type":sys.argv[5] if len(sys.argv)>5 else "client_credentials","client_id":sys.argv[1],"client_secret":sys.argv[2],"scope":sys.argv[3],"audience":sys.argv[4]}))' "$@" | tr -d '\r'
}

check() { # check "<label>" wantStatus [wantCode|-]
  local label="$1" want="$2" code="${3:--}" got_code ok=1
  N=$((N+1)); got_code="$(jget error.code)"
  [ "$STATUS" = "$want" ] || ok=0
  if [ "$code" != "-" ]; then [ "$got_code" = "$code" ] || ok=0; fi
  if [ "$want" != "204" ] && [ "$want" != "-" ]; then
    case "$STATUS" in 2??) [ "$(jget success)" = "true" ] || ok=0 ;; *) [ "$(jget success)" = "false" ] || ok=0 ;; esac
  fi
  if [ "$ok" = 1 ]; then PASS=$((PASS+1)); printf "%03d PASS %-72s want %s %s got %s %s\n" "$N" "$label" "$want" "$code" "$STATUS" "$got_code"
  else FAIL=$((FAIL+1)); printf "%03d FAIL %-72s want %s %s got %s %s\n" "$N" "$label" "$want" "$code" "$STATUS" "$got_code"; fi
}
assert() { # assert "<label>" "<actual>" "<expected>"
  N=$((N+1))
  if [ "$2" = "$3" ]; then PASS=$((PASS+1)); printf "%03d PASS %-72s (%s)\n" "$N" "$1" "$3"
  else FAIL=$((FAIL+1)); printf "%03d FAIL %-72s expected '%s' got '%s'\n" "$N" "$1" "$3" "$2"; fi
}
assert_match() { # assert_match "<label>" "<actual>" "<regex>"
  N=$((N+1))
  if [[ "$2" =~ $3 ]]; then PASS=$((PASS+1)); printf "%03d PASS %-72s (matches %s)\n" "$N" "$1" "$3"
  else FAIL=$((FAIL+1)); printf "%03d FAIL %-72s '%s' !~ %s\n" "$N" "$1" "$2" "$3"; fi
}
# headers common to every token response
common() { # common "<label>"
  assert "$1: Cache-Control no-store" "$(header cache-control)" "no-store"
}

# ----------------------------------------------------------------------------- preflight
echo "== preflight"
code="$(curl -s -o /dev/null -w '%{http_code}' "$INTERNAL_URL/internal/health/live" || true)"
[ "$code" = "200" ] || { echo "internal listener not reachable at $INTERNAL_URL (got $code). Start: set env (see header), npm run migrate, npx tsx src/server.ts"; exit 2; }
psql_q "SELECT 1 FROM knex_migrations WHERE name LIKE '20261007000300%'" | grep -q 1 \
  || { echo "migration 20261007000300 (service_clients) not applied: run npm run migrate"; exit 2; }
echo "internal listener up; service_clients migration applied"

# ----------------------------------------------------------------------------- provisioning script: argument validation
echo; echo "== provision-service-client.ts: argument validation (exit 1, message names the argument, never the value)"
prov_fail() { # prov_fail "<label>" "<arg-name-expected-in-message>" args...
  local label="$1" want="$2"; shift 2
  local out rc
  out="$(npx tsx scripts/provision-service-client.ts "$@" 2>&1 >/dev/null)"; rc=$?
  N=$((N+1))
  if [ "$rc" = 1 ] && [[ "$out" == *"$want"* ]] && [[ "$out" != *BADVALUE123* ]]; then PASS=$((PASS+1)); printf "%03d PASS %-72s exit 1, message names %s\n" "$N" "$label" "$want"
  else FAIL=$((FAIL+1)); printf "%03d FAIL %-72s rc=%s msg='%s'\n" "$N" "$label" "$rc" "$out"; fi
}
prov_fail "no arguments"                        "--client-id"
prov_fail "bad client id (value not echoed)"    "--client-id" --client-id BADVALUE123 --name x --scopes users:read --audiences vcare-identity
prov_fail "missing name"                        "--name"      --client-id qa-x1 --scopes users:read --audiences vcare-identity
prov_fail "unknown scope (value not echoed)"    "--scopes"    --client-id qa-x1 --name x --scopes BADVALUE123 --audiences vcare-identity
prov_fail "bad audience (value not echoed)"     "--audiences" --client-id qa-x1 --name x --scopes users:read --audiences BADVALUE123
prov_fail "unknown flag"                        "--frobnicate" --client-id qa-x1 --frobnicate yes
prov_fail "positional argument"                 "positional"  qa-x1
prov_fail "--leaked without --rotate"           "--leaked"    --client-id qa-x1 --name x --scopes users:read --audiences vcare-identity --leaked
prov_fail "overlap 0"                           "--overlap-hours" --client-id qa-x1 --rotate --overlap-hours 0
prov_fail "overlap 169"                         "--overlap-hours" --client-id qa-x1 --rotate --overlap-hours 169
prov_fail "overlap abc"                         "--overlap-hours" --client-id qa-x1 --rotate --overlap-hours abc
prov_fail "overlap with --leaked"               "--"          --client-id qa-x1 --rotate --leaked --overlap-hours 2

# ----------------------------------------------------------------------------- provisioning: new client, SQL + secret handling
echo; echo "== provision-service-client.ts: new client"
CID="qa-care-${RUN}"
npx tsx scripts/provision-service-client.ts --client-id "$CID" --name "QA care ${RUN}" \
  --scopes "users:read users:status:write" --audiences vcare-identity > "$TMP/new.sql" 2> "$TMP/new.err"
assert "new client: exit 0" "$?" "0"
S1="$(sed -n 2p "$TMP/new.err" | tr -d '\r')"; needle "$S1"
assert "new client: stderr is banner + secret + rule (3 lines)" "$(wc -l < "$TMP/new.err" | tr -d ' ')" "3"
assert_match "new client: secret is 43 base64url chars (256 bit)" "$S1" '^[A-Za-z0-9_-]{43}$'
assert "new client: stdout is exactly one INSERT statement" "$(grep -c '^INSERT INTO service_clients' "$TMP/new.sql")" "1"
assert "new client: plaintext secret absent from SQL (BR-24)" "$(grep -cF "$S1" "$TMP/new.sql")" "0"
assert "new client: SQL carries an argon2id hash" "$(grep -c "'\\\$argon2id\\\$" "$TMP/new.sql")" "1"
assert "new client: stdout has no banner" "$(grep -c 'CLIENT SECRET' "$TMP/new.sql")" "0"
grep -o "\$argon2id\$[^']*" "$TMP/new.sql" | head -1 >> "$TMP/needles"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$TMP/new.sql" >/dev/null 2>&1; assert "new client: psql -f applies the SQL" "$?" "0"
assert "new client: row is active, 2 scopes, 1 audience" "$(psql_q "SELECT is_active||'/'||cardinality(allowed_scopes)||'/'||cardinality(allowed_audiences) FROM service_clients WHERE client_id='$CID' AND deleted_at IS NULL")" "true/2/1"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$TMP/new.sql" >/dev/null 2>&1; assert "new client: applying the same INSERT twice is refused (uq_service_clients_client_id)" "$?" "3"

# ----------------------------------------------------------------------------- token endpoint: happy paths
echo; echo "== POST /internal/auth/token: success"
mint() { # mint client secret scope audience -> sets TOKEN
  tokreq "$(body_json "$1" "$2" "$3" "$4")"; TOKEN="$(jget data.access_token)"; needle "$TOKEN"
}
tokreq "$(body_json "$CID" "$S1" "users:read users:status:write" vcare-identity)"
check "JSON: valid exchange" 200
TOKEN="$(jget data.access_token)"; needle "$TOKEN"
common "JSON success"
assert "response: token_type" "$(jget data.token_type)" "Bearer"
assert "response: expires_in" "$(jget data.expires_in)" "300"
assert "response: scope" "$(jget data.scope)" "users:read users:status:write"
assert "response: data keys are exactly access_token,token_type,expires_in,scope" "$(python -c 'import json,sys;print(",".join(sorted(json.load(sys.stdin)["data"])))' < "$TMP/body" | tr -d '\r')" "access_token,expires_in,scope,token_type"
assert "response: no Set-Cookie (no refresh token)" "$(header set-cookie)" ""
assert "response: X-Request-Id echoed" "$(header x-request-id)" "$RID"
assert "response: Content-Type is JSON" "$(header content-type | cut -d';' -f1)" "application/json"

echo; echo "-- the issued JWT verifies against /.well-known/jwks.json and carries the BR-7 claims"
curl -s "$PUBLIC_URL/.well-known/jwks.json" -o "$TMP/jwks.json"
assert "jwks: public keys only (no private scalar 'd')" "$(grep -c '"d"' "$TMP/jwks.json")" "0"
CLAIMS="$(TOKEN="$TOKEN" JWKS="$TMP/jwks.json" node -e '
const fs=require("fs");
import("jose").then(async (jose)=>{
  const jwks=JSON.parse(fs.readFileSync(process.env.JWKS,"utf8"));
  const local=jose.createLocalJWKSet(jwks);
  const {payload,protectedHeader}=await jose.jwtVerify(process.env.TOKEN,local,{issuer:"vcare-identity",algorithms:["EdDSA"]});
  console.log(JSON.stringify({alg:protectedHeader.alg,typ:protectedHeader.typ,kid:!!protectedHeader.kid,iss:payload.iss,sub:payload.sub,ctyp:payload.typ,
    audType:typeof payload.aud,aud:payload.aud,scope:payload.scope,ttl:payload.exp-payload.iat,jti:typeof payload.jti,
    keys:Object.keys(payload).sort().join(",")}));
}).catch((e)=>{console.log(JSON.stringify({error:String(e.code||e.name)}))});' | tr -d '\r')"
cl() { printf '%s' "$CLAIMS" | python -c 'import json,sys;d=json.load(sys.stdin);v=d.get(sys.argv[1]);print(json.dumps(v) if isinstance(v,(bool,list,dict)) else ("" if v is None else v))' "$1" | tr -d '\r'; }
assert "jwt: signature verifies against JWKS (EdDSA)" "$(cl alg)" "EdDSA"
assert "jwt: header typ JWT"       "$(cl typ)" "JWT"
assert "jwt: header carries kid"   "$(cl kid)" "true"
assert "jwt: iss"                  "$(cl iss)" "vcare-identity"
assert "jwt: sub is the client_id" "$(cl sub)" "$CID"
assert "jwt: typ=service"          "$(cl ctyp)" "service"
assert "jwt: aud is a single string (D-2)" "$(cl audType)" "string"
assert "jwt: aud value"            "$(cl aud)" "vcare-identity"
assert "jwt: scope claim"          "$(cl scope)" "users:read users:status:write"
assert "jwt: exp - iat = 300"      "$(cl ttl)" "300"
assert "jwt: jti is a string"      "$(cl jti)" "string"
assert "jwt: claim set is exactly aud,exp,iat,iss,jti,scope,sub,typ" "$(cl keys)" "aud,exp,iat,iss,jti,scope,sub,typ"

echo; echo "-- form encoding, scope subset, de-duplication, ignored inputs"
IPFIX=""
formreq "grant_type=client_credentials&client_id=$CID&client_secret=$S1&scope=users%3Aread&audience=vcare-identity"
check "form (application/x-www-form-urlencoded): valid exchange" 200
FTOKEN="$(jget data.access_token)"; needle "$FTOKEN"; common "form success"
assert "form: granted scope is the requested subset (D-6)" "$(jget data.scope)" "users:read"
formreq "grant_type=client_credentials&client_id=$CID&client_secret=$S1&scope=users%3Aread+users%3Astatus%3Awrite&audience=vcare-identity" -H "Content-Type: application/x-www-form-urlencoded; charset=UTF-8"
check "form with charset parameter on Content-Type" 200
tokreq "$(body_json "$CID" "$S1" "users:read users:read users:status:write users:read" vcare-identity)"
check "duplicate scopes in request" 200
assert "duplicate scopes are de-duplicated, first-seen order" "$(jget data.scope)" "users:read users:status:write"
tokreq "$(body_json "$CID" "$S1" "users:status:write users:read" vcare-identity)"
assert "scope order follows the request" "$(jget data.scope)" "users:status:write users:read"
KEY="$(uuid)"
tokreq "$(body_json "$CID" "$S1" "users:read" vcare-identity)" -H "Idempotency-Key: $KEY"; A="$(jget data.access_token)"; needle "$A"
tokreq "$(body_json "$CID" "$S1" "users:read" vcare-identity)" -H "Idempotency-Key: $KEY"; B="$(jget data.access_token)"; needle "$B"
assert "Idempotency-Key is ignored: two exchanges mint two different tokens" "$([ -n "$A" ] && [ "$A" != "$B" ] && echo different)" "different"

# ----------------------------------------------------------------------------- 401 identity
echo; echo "== 401 InvalidCredentials: unknown / wrong secret / disabled / soft-deleted are indistinguishable (BR-1)"
WRONG="$(python -c "print('x'*43)")"
D_ID="qa-dis-${RUN}"; X_ID="qa-del-${RUN}"
for c in "$D_ID" "$X_ID"; do
  npx tsx scripts/provision-service-client.ts --client-id "$c" --name "QA $c" --scopes "users:read" --audiences vcare-identity > "$TMP/$c.sql" 2> "$TMP/$c.err"
  needle "$(sed -n 2p "$TMP/$c.err" | tr -d '\r')"
  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$TMP/$c.sql" >/dev/null 2>&1
done
D_SEC="$(sed -n 2p "$TMP/$D_ID.err" | tr -d '\r')"; X_SEC="$(sed -n 2p "$TMP/$X_ID.err" | tr -d '\r')"
# a token issued to the client before it is disabled (BR-17 below)
tokreq "$(body_json "$D_ID" "$D_SEC" "users:read" vcare-identity)"; PRE_DISABLE_TOKEN="$(jget data.access_token)"; needle "$PRE_DISABLE_TOKEN"
psql_q "UPDATE service_clients SET is_active=false, updated_at=now() WHERE client_id='$D_ID'" >/dev/null
psql_q "UPDATE service_clients SET deleted_at=now(), updated_at=now() WHERE client_id='$X_ID'" >/dev/null

tokreq "$(body_json "qa-nobody-${RUN}" "$WRONG" "users:read" vcare-identity)"; check "unknown client" 401 InvalidCredentials; common "401"; U_ERR="$(norm_err)"; U_MSG="$(jget error.message)"
tokreq "$(body_json "$CID" "$WRONG" "users:read" vcare-identity)";        check "known client, wrong secret" 401 InvalidCredentials; W_ERR="$(norm_err)"
tokreq "$(body_json "$D_ID" "$D_SEC" "users:read" vcare-identity)";       check "disabled client, correct secret" 401 InvalidCredentials; D_ERR="$(norm_err)"
tokreq "$(body_json "$X_ID" "$X_SEC" "users:read" vcare-identity)";       check "soft-deleted client, correct secret" 401 InvalidCredentials; X_ERR="$(norm_err)"
assert "unknown vs wrong-secret bodies identical (minus requestId)" "$U_ERR" "$W_ERR"
assert "unknown vs disabled bodies identical" "$U_ERR" "$D_ERR"
assert "unknown vs soft-deleted bodies identical" "$U_ERR" "$X_ERR"
assert "401 message is generic" "$U_MSG" "Invalid credentials"
tokreq "$(body_json "$CID" "$WRONG" "foo:bar" "vcare-evil")"; check "wrong secret + bad scope + bad audience stays 401 (BR-4: allow-lists not leaked)" 401 InvalidCredentials
tokreq "$(body_json "qa-nobody-${RUN}" "$WRONG" "doctors:read" "vcare-care")"; check "unknown client + disallowed scope/audience stays 401" 401 InvalidCredentials

echo "-- timing sample (informational; each path runs one argon2id verify)"
for label in "unknown:qa-nobody-${RUN}:$WRONG" "wrong:$CID:$WRONG" "disabled:$D_ID:$D_SEC"; do
  IFS=: read -r nm cid sec <<<"$label"
  t=$(curl -s -o /dev/null -w "%{time_total}" -X POST "$INTERNAL_URL/internal/auth/token" -H "X-Forwarded-For: $(newip)" -H "Content-Type: application/json" --data "$(body_json "$cid" "$sec" users:read vcare-identity)")
  echo "   $nm: ${t}s"
done

# ----------------------------------------------------------------------------- 403
echo; echo "== 403 InsufficientScope (only after the secret verified)"
tokreq "$(body_json "$CID" "$S1" "doctors:read" vcare-identity)";                check "scope in vocabulary but not allowed for client" 403 InsufficientScope; common "403"
tokreq "$(body_json "$CID" "$S1" "foo:bar" vcare-identity)";                     check "well-formed unknown scope foo:bar (D-6)" 403 InsufficientScope
tokreq "$(body_json "$CID" "$S1" "users:read doctors:read" vcare-identity)";     check "one allowed + one disallowed scope: whole request refused" 403 InsufficientScope
tokreq "$(body_json "$CID" "$S1" "users:read" vcare-care)";                      check "audience not in allowed_audiences (D-1)" 403 InsufficientScope
assert "403 message does not reveal the allow-lists" "$(jget error.message | grep -ciE 'users:|vcare-identity')" "0"

# ----------------------------------------------------------------------------- 400
echo; echo "== 400 ValidationFailed"
V() { tokreq "$1"; check "$2" 400 ValidationFailed; }
V "$(body_json "$CID" "$S1" "users:read" vcare-identity password)"        "grant_type != client_credentials"
V '{"client_id":"'"$CID"'","client_secret":"'"$S1"'","scope":"users:read","audience":"vcare-identity"}' "grant_type missing"
V "$(body_json "BAD_ID" "$S1" "users:read" vcare-identity)"               "client_id fails pattern"
V "$(body_json "ab" "$S1" "users:read" vcare-identity)"                   "client_id too short"
V "$(body_json "$CID" "short" "users:read" vcare-identity)"               "client_secret shorter than 32"
V "$(body_json "$CID" "$(python -c "print('x'*257)")" "users:read" vcare-identity)" "client_secret longer than 256"
V "$(body_json "$CID" "$S1" "" vcare-identity)"                           "empty scope (D-6)"
V "$(body_json "$CID" "$S1" "Users:Read" vcare-identity)"                 "scope with uppercase"
V "$(body_json "$CID" "$S1" "users:read  users:status:write" vcare-identity)" "scope with double space"
V "$(body_json "$CID" "$S1" "users" vcare-identity)"                      "scope without colon"
V "$(body_json "$CID" "$S1" "$(python -c "print('a:b '*70)")" vcare-identity)" "scope over 256 chars (C-2)"
V "$(body_json "$CID" "$S1" "users:read" "Vcare-Identity")"               "audience fails pattern"
V "$(body_json "$CID" "$S1" "users:read" "vcare-$(python -c "print('a'*70)")")" "audience over 64 chars (C-2)"
V '{"grant_type":"client_credentials","client_id":"'"$CID"'","client_secret":"'"$S1"'","scope":"users:read","audience":"vcare-identity","extra":"x"}' "unknown property rejected"
V '{"grant_type":"client_credentials","client_id":123,"client_secret":"'"$S1"'","scope":"users:read","audience":"vcare-identity"}' "client_id not a string"
V '{"grant_type":"client_credentials","client_id":"'"$CID"'","client_secret":"'"$S1"'","scope":["users:read"],"audience":"vcare-identity"}' "scope as array"
V '{not json' "malformed JSON"
V '' "empty body"
tokreq '[]'; check "JSON array body" 400 ValidationFailed
tokreq "plain text" -H "Content-Type: text/plain"; check "unsupported content type text/plain" 400 ValidationFailed
formreq "grant_type=client_credentials&client_id=$CID&client_id=$CID&client_secret=$S1&scope=users%3Aread&audience=vcare-identity"
check "form with repeated key" 400 ValidationFailed
formreq "grant_type=client_credentials&client_id=$CID&scope=users%3Aread&audience=vcare-identity"
check "form missing client_secret" 400 ValidationFailed
assert "400 envelope: details[0] has field + issue" "$(python -c 'import json,sys;d=json.load(sys.stdin)["error"]["details"][0];print(sorted(d))' < "$TMP/body" | tr -d '\r')" "['field', 'issue']"
tokreq "$(body_json "$CID" "short-secret-$S1-but-wrong-scope" "BAD SCOPE" vcare-identity)"
check "(secret echo) invalid body" 400 ValidationFailed
assert "400 body never echoes the submitted secret or its value" "$(grep -c "short-secret" "$TMP/body")" "0"
common "400"

# ----------------------------------------------------------------------------- HTTP method / route shape
echo; echo "== route shape and method"
req "$INTERNAL_URL" GET /internal/auth/token - ""; echo "   GET /internal/auth/token -> $STATUS"; N=$((N+1)); case "$STATUS" in 404|405) PASS=$((PASS+1)); echo "$(printf '%03d' $N) PASS GET on the token route is not a 5xx ($STATUS)";; *) FAIL=$((FAIL+1)); echo "$(printf '%03d' $N) FAIL GET on token route gave $STATUS";; esac
req "$INTERNAL_URL" PUT /internal/auth/token - ""; N=$((N+1)); case "$STATUS" in 404|405) PASS=$((PASS+1)); echo "$(printf '%03d' $N) PASS PUT on the token route is not a 5xx ($STATUS)";; *) FAIL=$((FAIL+1)); echo "$(printf '%03d' $N) FAIL PUT gave $STATUS";; esac
req "$INTERNAL_URL" POST /internal/auth/tokens - "{}"; check "unknown internal path /internal/auth/tokens" 404 NotFound
req "$INTERNAL_URL" GET /internal/users - ""; check "/internal/users (internal-users module not built yet)" 404 NotFound

# ----------------------------------------------------------------------------- X-Request-Id
echo; echo "== X-Request-Id"
tokreq "$(body_json "$CID" "$S1" "users:read" vcare-identity)" ; assert "valid caller id echoed" "$(header x-request-id)" "$RID"
curl -s -o /dev/null -D "$TMP/headers" -X POST "$INTERNAL_URL/internal/auth/token" -H "X-Forwarded-For: $(newip)" -H "X-Request-Id: not-a-uuid" -H "Content-Type: application/json" --data '{}'
assert_match "invalid caller id replaced by a generated UUID" "$(header x-request-id)" '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
curl -s -o /dev/null -D "$TMP/headers" -X POST "$INTERNAL_URL/internal/auth/token" -H "X-Forwarded-For: $(newip)" -H "Content-Type: application/json" --data '{}'
assert_match "absent caller id generated" "$(header x-request-id)" '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'

# ----------------------------------------------------------------------------- last_used_at (BR-20)
echo; echo "== last_used_at (async, at most once a minute)"
LU_ID="qa-lu-${RUN}"
npx tsx scripts/provision-service-client.ts --client-id "$LU_ID" --name "QA lu" --scopes "users:read" --audiences vcare-identity > "$TMP/lu.sql" 2> "$TMP/lu.err"
LU_SEC="$(sed -n 2p "$TMP/lu.err" | tr -d '\r')"; needle "$LU_SEC"; psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$TMP/lu.sql" >/dev/null 2>&1
assert "last_used_at null before first use" "$(psql_q "SELECT last_used_at IS NULL FROM service_clients WHERE client_id='$LU_ID'")" "t"
mint "$LU_ID" "$LU_SEC" users:read vcare-identity; sleep 1
FIRST="$(psql_q "SELECT last_used_at FROM service_clients WHERE client_id='$LU_ID'")"
assert "last_used_at set after first success" "$([ -n "$FIRST" ] && echo set)" "set"
mint "$LU_ID" "$LU_SEC" users:read vcare-identity; sleep 1
assert "second success within a minute does not move it" "$(psql_q "SELECT last_used_at FROM service_clients WHERE client_id='$LU_ID'")" "$FIRST"
tokreq "$(body_json "$LU_ID" "$WRONG" users:read vcare-identity)"; sleep 1
assert "failed exchange does not touch it" "$(psql_q "SELECT last_used_at FROM service_clients WHERE client_id='$LU_ID'")" "$FIRST"
psql_q "UPDATE service_clients SET last_used_at = last_used_at - interval '2 minutes' WHERE client_id='$LU_ID'" >/dev/null
OLD="$(psql_q "SELECT last_used_at FROM service_clients WHERE client_id='$LU_ID'")"
mint "$LU_ID" "$LU_SEC" users:read vcare-identity; sleep 1
assert "advances after a minute" "$([ "$(psql_q "SELECT last_used_at > '$OLD'::timestamptz FROM service_clients WHERE client_id='$LU_ID'")" = t ] && echo moved)" "moved"

# ----------------------------------------------------------------------------- rotation
echo; echo "== secret rotation with overlap (--rotate), expiry, and --leaked"
npx tsx scripts/provision-service-client.ts --client-id "$CID" --rotate --overlap-hours 1 > "$TMP/rot.sql" 2> "$TMP/rot.err"
assert "rotate: exit 0" "$?" "0"
S2="$(sed -n 2p "$TMP/rot.err" | tr -d '\r')"; needle "$S2"
assert "rotate: new secret differs from the old" "$([ "$S2" != "$S1" ] && echo different)" "different"
assert "rotate: SQL is one UPDATE (no INSERT)" "$(grep -c '^UPDATE service_clients' "$TMP/rot.sql")/$(grep -c 'INSERT' "$TMP/rot.sql")" "1/0"
assert "rotate: SQL moves the current hash to previous_secret_hash" "$(grep -c 'previous_secret_hash = client_secret_hash' "$TMP/rot.sql")" "1"
assert "rotate: SQL sets a 1 hour overlap" "$(grep -c "interval '1 hours'" "$TMP/rot.sql")" "1"
assert "rotate: SQL targets live row only" "$(grep -c "deleted_at IS NULL" "$TMP/rot.sql")" "1"
assert "rotate: plaintext secrets absent from SQL" "$(grep -cF -e "$S1" -e "$S2" "$TMP/rot.sql")" "0"
grep -o "\$argon2id\$[^']*" "$TMP/rot.sql" | head -1 >> "$TMP/needles"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$TMP/rot.sql" >/dev/null 2>&1; assert "rotate: psql -f applies" "$?" "0"
assert "rotate: previous_* set and secret_rotated_at set" "$(psql_q "SELECT (previous_secret_hash IS NOT NULL)||'/'||(previous_secret_expires_at > now() + interval '59 minutes')||'/'||(secret_rotated_at IS NOT NULL) FROM service_clients WHERE client_id='$CID' AND deleted_at IS NULL")" "true/true/true"
tokreq "$(body_json "$CID" "$S2" users:read vcare-identity)"; check "overlap: NEW secret works" 200
tokreq "$(body_json "$CID" "$S1" users:read vcare-identity)"; check "overlap: OLD secret still works" 200
tokreq "$(body_json "$CID" "$WRONG" users:read vcare-identity)"; check "overlap: random secret still refused" 401 InvalidCredentials
psql_q "UPDATE service_clients SET previous_secret_expires_at = now() - interval '1 minute' WHERE client_id='$CID' AND deleted_at IS NULL" >/dev/null
tokreq "$(body_json "$CID" "$S1" users:read vcare-identity)"; check "after overlap expiry: OLD secret refused" 401 InvalidCredentials
tokreq "$(body_json "$CID" "$S2" users:read vcare-identity)"; check "after overlap expiry: NEW secret works" 200
npx tsx scripts/provision-service-client.ts --client-id "$CID" --rotate --leaked > "$TMP/leak.sql" 2> "$TMP/leak.err"
S3="$(sed -n 2p "$TMP/leak.err" | tr -d '\r')"; needle "$S3"
assert "leaked: SQL clears previous_*" "$(grep -c 'previous_secret_hash = NULL' "$TMP/leak.sql")/$(grep -c 'previous_secret_expires_at = NULL' "$TMP/leak.sql")" "1/1"
grep -o "\$argon2id\$[^']*" "$TMP/leak.sql" | head -1 >> "$TMP/needles"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$TMP/leak.sql" >/dev/null 2>&1; assert "leaked: psql -f applies (pair CHECK holds)" "$?" "0"
tokreq "$(body_json "$CID" "$S3" users:read vcare-identity)"; check "leaked: newest secret works" 200
tokreq "$(body_json "$CID" "$S2" users:read vcare-identity)"; check "leaked: previous secret refused at once" 401 InvalidCredentials
tokreq "$(body_json "$CID" "$S1" users:read vcare-identity)"; check "leaked: oldest secret refused" 401 InvalidCredentials
S1="$S3"
assert "rotate for an unknown client_id updates 0 rows (script cannot tell)" "$(npx tsx scripts/provision-service-client.ts --client-id qa-ghost-${RUN} --rotate 2>/dev/null | psql "$DATABASE_URL" -tA 2>&1 | tr -d '\r')" "UPDATE 0"

echo; echo "== soft-delete frees the client_id (BR-22): re-provision the deleted id"
npx tsx scripts/provision-service-client.ts --client-id "$X_ID" --name "QA reborn" --scopes "users:read" --audiences vcare-identity > "$TMP/re.sql" 2> "$TMP/re.err"
X2="$(sed -n 2p "$TMP/re.err" | tr -d '\r')"; needle "$X2"
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$TMP/re.sql" >/dev/null 2>&1; assert "INSERT with a soft-deleted client_id succeeds" "$?" "0"
tokreq "$(body_json "$X_ID" "$X2" users:read vcare-identity)"; check "re-provisioned client works with its new secret" 200
tokreq "$(body_json "$X_ID" "$X_SEC" users:read vcare-identity)"; check "the soft-deleted row's old secret does not" 401 InvalidCredentials

# ----------------------------------------------------------------------------- seed script
echo; echo "== seed-service-client.ts (dev only)"
SEED_OUT="$(DATABASE_URL="$DATABASE_URL" npm run --silent seed:service-client 2> "$TMP/seed.err")"; rc=$?
assert "seed: exit 0" "$rc" "0"
assert "seed: stdout is client_id=... and client_secret=... only" "$(printf '%s\n' "$SEED_OUT" | cut -d= -f1 | tr -d '\r' | paste -sd, -)" "client_id,client_secret"
SEED_ID="$(printf '%s\n' "$SEED_OUT" | sed -n 's/^client_id=//p' | tr -d '\r')"
SEED_SEC="$(printf '%s\n' "$SEED_OUT" | sed -n 's/^client_secret=//p' | tr -d '\r')"; needle "$SEED_SEC"
assert "seed: default client_id" "$SEED_ID" "care-service"
assert "seed: stderr empty" "$(wc -c < "$TMP/seed.err" | tr -d ' ')" "0"
assert "seed: default scopes/audience stored" "$(psql_q "SELECT array_to_string(allowed_scopes,' ')||'|'||array_to_string(allowed_audiences,' ') FROM service_clients WHERE client_id='care-service' AND deleted_at IS NULL")" "users:read users:status:write|vcare-identity"
assert "seed: secret not stored in plaintext (hash is argon2id)" "$(psql_q "SELECT (client_secret_hash LIKE '\$argon2id\$%') AND position('$SEED_SEC' in client_secret_hash)=0 FROM service_clients WHERE client_id='care-service' AND deleted_at IS NULL")" "t"
tokreq "$(body_json care-service "$SEED_SEC" "users:read users:status:write" vcare-identity)"; check "seeded care-service can exchange" 200
needle "$(jget data.access_token)"
SEED_OUT2="$(DATABASE_URL="$DATABASE_URL" npm run --silent seed:service-client 2>/dev/null)"; SEED_SEC2="$(printf '%s\n' "$SEED_OUT2" | sed -n 's/^client_secret=//p' | tr -d '\r')"; needle "$SEED_SEC2"
assert "seed: re-run upserts a fresh secret" "$([ -n "$SEED_SEC2" ] && [ "$SEED_SEC2" != "$SEED_SEC" ] && echo fresh)" "fresh"
assert "seed: re-run leaves exactly one live care-service row" "$(psql_q "SELECT count(*) FROM service_clients WHERE client_id='care-service' AND deleted_at IS NULL")" "1"
tokreq "$(body_json care-service "$SEED_SEC" "users:read" vcare-identity)"; check "seed: previous seed secret no longer works (no overlap)" 401 InvalidCredentials
tokreq "$(body_json care-service "$SEED_SEC2" "users:read" vcare-identity)"; check "seed: new seed secret works" 200
PROD_OUT="$(NODE_ENV=production DATABASE_URL="$DATABASE_URL" npm run --silent seed:service-client 2>&1)"; rc=$?
assert "seed: NODE_ENV=production refused (exit 1)" "$rc" "1"
assert "seed: refusal prints no secret" "$(printf '%s' "$PROD_OUT" | grep -c 'client_secret')" "0"
SEED_BAD="$(DATABASE_URL="$DATABASE_URL" npm run --silent seed:service-client -- --scopes BADVALUE123 2>&1)"; rc=$?
assert "seed: bad scope exit 1" "$rc" "1"
assert "seed: bad scope message names the argument, not the value" "$(printf '%s' "$SEED_BAD" | grep -c BADVALUE123)/$(printf '%s' "$SEED_BAD" | grep -c -- '--scopes')" "0/1"
SEED_NODB="$(env -u DATABASE_URL npm run --silent seed:service-client 2>&1)"; rc=$?
assert "seed: without DATABASE_URL exit 1" "$rc" "1"

# ----------------------------------------------------------------------------- rate limits
echo; echo "== rate limits (Redis sliding window; limiters run before validation and hashing)"
echo "-- token-ip: 30/min per client IP (unique unknown client_id per request so the client bucket stays small)"
IPFIX="$(newip)"; first429=0
for i in $(seq 1 32); do
  tokreq "$(body_json "qa-ip-${RUN}-$i" "$WRONG" users:read vcare-identity)"
  if [ "$STATUS" = "429" ] && [ "$first429" = 0 ]; then first429=$i; cp "$TMP/headers" "$TMP/h429"; cp "$TMP/body" "$TMP/b429"; fi
done
assert "token-ip: first 429 is request #31" "$first429" "31"
cp "$TMP/h429" "$TMP/headers"; cp "$TMP/b429" "$TMP/body"
assert "token-ip 429: error.code" "$(jget error.code)" "RateLimited"
assert_match "token-ip 429: Retry-After is whole seconds in 1..60" "$(header retry-after)" '^([1-9]|[1-5][0-9]|60)$'
common "token-ip 429"
assert "token-ip 429: success=false" "$(jget success)" "false"
IPFIX=""
tokreq "$(body_json "$CID" "$S1" users:read vcare-identity)"; check "token-ip: a different IP is unaffected" 200

echo "-- token-client: 60/min per client_id (distinct IPs, so it is the client bucket that trips)"
RL_ID="qa-rl-${RUN}"
npx tsx scripts/provision-service-client.ts --client-id "$RL_ID" --name "QA rl" --scopes "users:read" --audiences vcare-identity > "$TMP/rl.sql" 2> "$TMP/rl.err"
RL_SEC="$(sed -n 2p "$TMP/rl.err" | tr -d '\r')"; needle "$RL_SEC"; psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 -f "$TMP/rl.sql" >/dev/null 2>&1
IPFIX=""; bad=0
for i in $(seq 1 60); do
  tokreq "$(body_json "$RL_ID" "$WRONG" users:read vcare-identity)"
  [ "$STATUS" = "401" ] || bad=$((bad+1))
done
assert "token-client: requests 1..60 all answered 401 (not limited)" "$bad" "0"
tokreq "$(body_json "$RL_ID" "$RL_SEC" users:read vcare-identity)"
check "token-client: request #61 is 429 even with the CORRECT secret (limiter before hashing)" 429 RateLimited
assert_match "token-client 429: Retry-After whole seconds" "$(header retry-after)" '^([1-9]|[1-5][0-9]|60)$'
common "token-client 429"
assert "token-client 429: no access_token in body" "$(grep -c access_token "$TMP/body")" "0"
tokreq "$(body_json "$CID" "$S1" users:read vcare-identity)"; check "token-client: other client unaffected" 200


# ----------------------------------------------------------------------------- health
echo; echo "== internal health probes"
req "$INTERNAL_URL" GET /internal/health/live - ""; assert "live: 200" "$STATUS" "200"
assert "live: bare body {status:ok} (not enveloped)" "$(cat "$TMP/body")" '{"status":"ok"}'
common "live"; assert "live: X-Request-Id echoed" "$(header x-request-id)" "$RID"
req "$INTERNAL_URL" GET /internal/health/ready - ""; assert "ready: 200" "$STATUS" "200"
assert_match "ready: status ok|degraded" "$(jget status)" '^(ok|degraded)$'
assert "ready: database check ok" "$(jget checks.database)" "up"
assert_match "ready: redis check reported" "$(jget checks.redis)" '^(up|down)$'
common "ready"; assert "ready: X-Request-Id echoed" "$(header x-request-id)" "$RID"
assert "ready: not enveloped (no 'success' key)" "$(jget success)" ""
req "$INTERNAL_URL" GET /internal/health/live "garbage" ""; assert "live with a garbage bearer is still open" "$STATUS" "200"
req "$PUBLIC_URL" GET /api/health/live - ""; assert "public live (for comparison)" "$STATUS" "200"

# ----------------------------------------------------------------------------- boundaries
echo; echo "== internal is not served on the public listener (BR-16)"
req "$PUBLIC_URL" POST /internal/auth/token - "$(body_json "$CID" "$S1" users:read vcare-identity)"; check "POST public:/internal/auth/token" 404 NotFound
assert "public 404 body carries no token" "$(grep -c access_token "$TMP/body")" "0"
req "$PUBLIC_URL" GET /internal/health/live - ""; check "GET public:/internal/health/live" 404 NotFound
req "$PUBLIC_URL" GET /internal/health/ready - ""; check "GET public:/internal/health/ready" 404 NotFound
req "$PUBLIC_URL" GET /internal/users - ""; check "GET public:/internal/users" 404 NotFound
req "$PUBLIC_URL" POST /api/auth/token - "$(body_json "$CID" "$S1" users:read vcare-identity)"; check "POST public:/api/auth/token (no such route)" 404 NotFound
req "$INTERNAL_URL" GET /api/auth/me - ""; check "internal listener does not serve /api/auth/me" 404 NotFound

echo; echo "== user tokens and service tokens on the wrong side"
HASH="$(PW="$PW" node -e 'import("argon2").then(a=>a.hash(process.env.PW,{type:a.argon2id,memoryCost:19456,timeCost:2,parallelism:1})).then(h=>process.stdout.write(h))')"
mkuser() { psql_q "INSERT INTO users (email, password_hash, full_name, role, status, email_verified_at, timezone, locale)
                   VALUES ('qa-sa-${RUN}-$1@example.test', '$HASH', 'QA $1', '$2', 'active', now(), 'UTC', 'en') RETURNING id" >/dev/null; }
mkuser patient patient; mkuser doctor doctor; mkuser admin admin
login() { # login <tag> -> TOKEN
  RID="$(uuid)"
  STATUS="$(curl -s -o "$TMP/body" -D "$TMP/headers" -w "%{http_code}" -X POST "$PUBLIC_URL/api/auth/login" -H "Content-Type: application/json" \
            -H "X-Request-Id: $RID" --data "{\"email\":\"qa-sa-${RUN}-$1@example.test\",\"password\":\"$PW\"}" | tr -d '\r')"
  TOKEN="$(jget data.accessToken)"; needle "$TOKEN"
}
login patient; PAT="$TOKEN"; login doctor; DOC="$TOKEN"; login admin; ADM="$TOKEN"
for v in PAT DOC ADM; do [ -n "${!v}" ] || { echo "fixture login failed for $v"; exit 2; }; done
echo "user tokens obtained for patient, doctor, admin (values never printed)"
for pair in "patient:$PAT" "doctor:$DOC" "admin:$ADM"; do
  role="${pair%%:*}"; tk="${pair#*:}"
  tokreq "$(body_json "$CID" "$S1" users:read vcare-identity)" -H "Authorization: Bearer $tk"
  check "token route ignores a $role bearer (credentials decide)" 200
  tokreq '{}' -H "Authorization: Bearer $tk"
  check "token route with $role bearer and no credentials is not a free pass" 400 ValidationFailed
  req "$INTERNAL_URL" GET /internal/users "$tk" ""
  check "$role token on /internal/users: route absent, so 404 not 200 (no guarded route exists yet)" 404 NotFound
done
tokreq "$(body_json "$CID" "$S1" users:read vcare-identity)" -H "X-User-Id: 1" -H "X-Role: admin" -H "X-Forwarded-User: admin"
check "spoofed X-User-Id / X-Role / X-Forwarded-User change nothing on the token route" 200
tokreq "$(body_json "$CID" "$S1" "users:read users:status:write" vcare-identity)"; SVC="$(jget data.access_token)"; needle "$SVC"
req "$PUBLIC_URL" GET /api/users "$SVC" ""; check "service token on public GET /api/users" 401 Unauthorized
req "$PUBLIC_URL" GET /api/auth/me "$SVC" ""; check "service token on public GET /api/auth/me" 401 Unauthorized
req "$PUBLIC_URL" PATCH /api/auth/me "$SVC" '{"fullName":"x"}'; check "service token on public PATCH /api/auth/me" 401 Unauthorized
req "$PUBLIC_URL" GET /api/users/1/sessions "$SVC" ""; check "service token on public GET /api/users/1/sessions" 401 Unauthorized
req "$PUBLIC_URL" GET /api/users "$PRE_DISABLE_TOKEN" ""; check "service token of a since-disabled client on public route" 401 Unauthorized

# ----------------------------------------------------------------------------- production env refinement (BR-23)
echo; echo "== env: production refuses INTERNAL_TRUST_PROXY_HOPS < 1 (BR-23)"
envkeys() { # envkeys <hops> -> invalidKeys list of the config error (process exits before listening)
  env -u JWT_PRIVATE_KEYS -u JWT_ACTIVE_KID NODE_ENV=production PORT=3999 INTERNAL_PORT=3998 TRUST_PROXY_HOPS=1 INTERNAL_TRUST_PROXY_HOPS="$1" \
      DATABASE_URL="$DATABASE_URL" REDIS_URL=redis://localhost:6379/2 timeout 90 npx tsx src/server.ts 2>&1 | grep -o '"invalidKeys":\[[^]]*\]' | head -1
}
K0="$(envkeys 0)"; K1="$(envkeys 1)"
assert "production, hops=0: INTERNAL_TRUST_PROXY_HOPS is reported invalid" "$(printf '%s' "$K0" | grep -c INTERNAL_TRUST_PROXY_HOPS)" "1"
assert "production, hops=1: INTERNAL_TRUST_PROXY_HOPS is not reported" "$(printf '%s' "$K1" | grep -c INTERNAL_TRUST_PROXY_HOPS)" "0"
assert "no listener was started by the env probe (port 3998 free)" "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3998/internal/health/live)" "000"

# ----------------------------------------------------------------------------- request-id and log hygiene
# last on purpose: it exhausts the shared "invalid" bucket, which also serves body-less requests, for a minute
echo "-- garbage client_id values share one bucket named 'invalid' (bounded Redis keys)"
first429=0
for i in $(seq 1 66); do
  tokreq "$(body_json "BAD_${i}" "$WRONG" users:read vcare-identity)"
  if [ "$STATUS" = "429" ] && [ "$first429" = 0 ]; then first429=$i; fi
done
assert_match "invalid bucket: a 429 appears within 61 requests (60/min shared)" "$first429" '^([1-9]|[1-5][0-9]|60|61)$'
assert "invalid bucket: key count in Redis db 2 has no per-garbage-id keys" "$(node -e '
const R=require("ioredis");const r=new R(process.env.REDIS_URL||"redis://localhost:6379/"+(process.env.REDIS_DB||2));
r.keys("*").then(k=>{console.log(k.filter(x=>x.includes("BAD_")).length);r.quit()})' | tr -d '\r')" "0"

echo; echo "== request-id coverage"
assert "every response echoed X-Request-Id (ok / bad)" "$RID_OK / $RID_BAD" "$RID_OK / 0"

echo; echo "== server log hygiene"
if [ -n "$SERVER_LOG" ] && [ -f "$SERVER_LOG" ]; then
  sort -u "$TMP/needles" -o "$TMP/needles"
  assert "log checked against N distinct secrets/tokens/hashes (N>=20)" "$([ "$(wc -l < "$TMP/needles")" -ge 20 ] && echo yes)" "yes"
  assert "log contains none of the plaintext secrets, issued tokens or hash strings" "$(grep -cF -f "$TMP/needles" "$SERVER_LOG")" "0"
  assert "log has no argon2 hash text" "$(grep -c 'argon2id\$' "$SERVER_LOG")" "0"
  assert "log has no 'client_secret' key" "$(grep -c 'client_secret' "$SERVER_LOG")" "0"
  assert "log has no 'access_token' key" "$(grep -c 'access_token' "$SERVER_LOG")" "0"
  assert "log has no Authorization / Bearer text" "$(grep -ciE 'authorization|bearer ' "$SERVER_LOG")" "0"
  assert "log has no e-mail address" "$(grep -c '@example.test' "$SERVER_LOG")" "0"
  assert "log has no JWT-shaped string" "$(grep -cE 'eyJ[A-Za-z0-9_-]{10,}\.' "$SERVER_LOG")" "0"
  assert "log has service_token_issued lines" "$([ "$(grep -c '"service_token_issued"' "$SERVER_LOG")" -gt 0 ] && echo yes)" "yes"
  assert "service_token_issued lines carry requestId, clientId, audience, scope" "$(grep '"service_token_issued"' "$SERVER_LOG" | grep -c '"requestId".*"clientId".*"audience".*"scope"\|"clientId".*"requestId"')" "$(grep -c '"service_token_issued"' "$SERVER_LOG")"
  assert "service_token_denied lines exist (warn)" "$([ "$(grep -c '"service_token_denied"' "$SERVER_LOG")" -gt 0 ] && echo yes)" "yes"
  for reason in unknown_client inactive bad_secret scope audience; do
    assert "service_token_denied reason=$reason logged" "$([ "$(grep '"service_token_denied"' "$SERVER_LOG" | grep -c "\"reason\":\"$reason\"")" -gt 0 ] && echo yes)" "yes"
  done
  assert "log lines are JSON objects (no stray text)" "$(grep -vc '^{' "$SERVER_LOG" | tr -d ' ')" "0"
  assert "no 5xx / error-level line during the run" "$(grep -c '"level":"error"' "$SERVER_LOG")" "0"
  echo "   log event counts: $(grep -o '"message":"[a-z_]*"' "$SERVER_LOG" | sort | uniq -c | sort -rn | head -8 | tr '\n' ' ')"
else
  echo "SERVER_LOG not set or not a file: log hygiene section SKIPPED"
fi

echo
echo "== summary: $PASS pass / $FAIL fail ($N checks)"
[ "$FAIL" = 0 ]
