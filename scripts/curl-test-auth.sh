#!/usr/bin/env bash
# Manual QA for the `auth` module of identity-service (docs/auth/manual-qa.md).
#
# Drives every /api/auth/* operation plus GET /.well-known/jwks.json with CURL against a running
# stack and compares status, error.code, details, headers and the echoed X-Request-Id with
# contracts/openapi.yaml and docs/auth/spec.md.
#
# Usage (stack already up, e.g. compose project vcare-identity-qa):
#   ./scripts/curl-test-auth.sh
#   BASE_URL=http://localhost:3000 COMPOSE_PROJECT=vcare-identity-qa ./scripts/curl-test-auth.sh
#
# Requirements: bash, curl, python (3.x, JSON parsing and uuid only), docker compose.
#
# How it runs without secrets:
#   * One-time codes are read at runtime from the worker's capture file
#     (EMAIL_PROVIDER=capture, EMAIL_CAPTURE_DIR=/tmp/mail inside the worker container).
#   * Account states (suspended, rejected) and expiry cases are produced with QA-only SQL fixtures
#     via `docker compose exec postgres psql` — there is no users/internal status endpoint yet.
#   * Redis sliding-window keys are cleared with FLUSHALL between groups so one group's traffic
#     never poisons another (throwaway stack only; never point this at a shared Redis).
#   * Refresh cookies are handled by hand (Set-Cookie parsed, `Cookie:` header sent) so that old
#     tokens can be replayed on purpose; one case also proves the real curl cookie jar works.
#   * Every email is synthetic and unique per run (@example.test); nothing is printed that contains
#     a token, code, cookie or email.
#
# The script is idempotent (unique emails per run) and leaves the rows it created in place.
# Exit status is non-zero when any check fails.
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3000}"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-vcare-identity-qa}"
PG_USER="${PG_USER:-identity}"
PG_DB="${PG_DB:-vcare_identity}"
GRACE_SECONDS="${REFRESH_REUSE_GRACE_SECONDS:-10}"
RUN_LOG_SCAN="${RUN_LOG_SCAN:-1}"
DC="docker compose -p $COMPOSE_PROJECT"

RUN="$(date +%s)$RANDOM"
PW1="QaPass-${RUN}-aa1!"
PW2="QaPass-${RUN}-bb2!"
PW3="QaPass-${RUN}-cc3!"

PASS=0
FAIL=0
N=0
RID_OK=0
RID_BAD=0
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
: > "$TMP/needles"
: > "$TMP/codes"

# ----------------------------------------------------------------------------- helpers
uuid() { python -c "import uuid;print(uuid.uuid4())" | tr -d '\r'; }

psql_q() { $DC exec -T postgres psql -U "$PG_USER" -d "$PG_DB" -tAc "$1" | tr -d '\r'; }
flush() { $DC exec -T redis redis-cli FLUSHALL >/dev/null; }

header() { { grep -i "^$1:" "$TMP/headers" || true; } | head -1 | cut -d" " -f2- | tr -d "\r"; }
# every Set-Cookie line for vcare_rt in the last response
cookie_line() { { grep -i "^set-cookie: vcare_rt=" "$TMP/headers" || true; } | head -1 | tr -d "\r"; }
cookie_value() { cookie_line | sed -E 's/^[Ss]et-[Cc]ookie: vcare_rt=([^;]*).*/\1/'; }
cookie_shape() { cookie_line | sed -E 's/vcare_rt=[^;]*/vcare_rt=<RT>/; s/^[Ss]et-[Cc]ookie: //'; }

jget() { # jget <dotted.path> : value from $TMP/body ("" when absent)
  python -c '
import json,sys
try:
    d=json.load(sys.stdin)
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

# call <METHOD> <PATH> [curl args...] -> sets S (status), RID; body in $TMP/body, headers in $TMP/headers
call() {
  local method="$1" path="$2"
  shift 2
  RID="$(uuid)"
  S="$(curl -s -o "$TMP/body" -D "$TMP/headers" -X "$method" -H "X-Request-Id: $RID" "$BASE_URL$path" "$@" -w "%{http_code}")" || S=000
  if [ "$(header X-Request-Id)" = "$RID" ]; then RID_OK=$((RID_OK + 1)); else RID_BAD=$((RID_BAD + 1)); fi
}
jpost() { local path="$1" body="$2"; shift 2; call POST "$path" -H "Content-Type: application/json" -d "$body" "$@"; }
jpatch() { local path="$1" body="$2"; shift 2; call PATCH "$path" -H "Content-Type: application/json" -d "$body" "$@"; }
bearer() { printf 'Authorization: Bearer %s' "$1"; }
cookie_hdr() { printf 'Cookie: vcare_rt=%s' "$1"; }

section() { printf "\n=== %s ===\n" "$1"; }

# check <label> <expected> <actual>
check() {
  local label="$1" expected="$2" actual="$3"
  N=$((N + 1))
  if [ "$expected" = "$actual" ]; then
    PASS=$((PASS + 1))
    printf "  PASS  [%03d] %s\n" "$N" "$label"
  else
    FAIL=$((FAIL + 1))
    printf "  FAIL  [%03d] %s\n        expected: %s\n        got:      %s\n" "$N" "$label" "$expected" "$actual"
  fi
}
# err <label> <status> <code> [field] : one check on status + error.code (+ details[0].field)
err() {
  local label="$1" status="$2" code="$3" field="${4-}" got
  got="$S $(jget error.code)"
  local want="$status $code"
  if [ -n "$field" ]; then got="$got $(jget error.details.0.field)"; want="$want $field"; fi
  check "$label" "$want" "$got"
}
# ok <label> <status> : status + success flag
okc() { check "$1" "$2 true" "$S $(jget success)"; }
has_set_cookie() { [ -n "$(cookie_line)" ] && echo yes || echo no; }
no_store() { echo "$(header Cache-Control)"; }
norm() { sed -E 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/<UUID>/g' "$TMP/body"; }
hdr_sig() { grep -iv '^\(x-request-id\|date\|etag\):' "$TMP/headers" | tr -d '\r' | sort; }
need() { echo "$1" >> "$TMP/needles"; }
need_code() { echo "$1" >> "$TMP/codes"; }

# ---- one-time codes from the worker capture file ----
mail_scan() { # mail_scan <email> <subject keyword> -> "<count> <latest code or ->"
  MSYS_NO_PATHCONV=1 $DC exec -T worker sh -c 'tail -n 400 /tmp/mail/outbox.jsonl 2>/dev/null || true' | tr -d '\r' |
    python -c '
import json,re,sys
email,kw=sys.argv[1],sys.argv[2].lower()
n=0;code="-"
for line in sys.stdin:
    try: m=json.loads(line)
    except Exception: continue
    if m.get("to")==email and kw in m.get("subject","").lower():
        n+=1
        hit=re.search(r"\b(\d{6})\b",m.get("text",""))
        code=hit.group(1) if hit else "-"
print(n,code)' "$1" "$2" | tr -d '\r'
}
mail_count() { mail_scan "$1" "$2" | cut -d" " -f1; }
await_code() { # await_code <email> <subject keyword> <baseline count> -> code (empty on timeout)
  local i out
  for i in $(seq 1 30); do
    out="$(mail_scan "$1" "$2")"
    if [ "${out%% *}" -gt "$3" ]; then echo "${out##* }"; return 0; fi
    sleep 1
  done
  echo ""
}
wrong_code() { if [ "$1" = "000000" ]; then echo "111111"; else echo "000000"; fi; }

# ---- request body builders ----
complete_body() { # <email> <code> <password> <role> [phone]
  local phone=""
  [ -n "${5-}" ] && phone=",\"phone\":\"$5\""
  printf '{"email":"%s","code":"%s","password":"%s","fullName":"QA User","role":"%s","timezone":"Africa/Cairo","locale":"en-US"%s}' \
    "$1" "$2" "$3" "$4" "$phone"
}
login_body() { printf '{"email":"%s","password":"%s"}' "$1" "$2"; }

# reg_user <email> <role> <password> : full registration (fixture + assertion). Leaves S/body of complete.
reg_user() {
  local email="$1" role="$2" pw="$3" base code
  flush
  base="$(mail_count "$email" "verification code")"
  jpost /api/auth/register/start "{\"email\":\"$email\"}"
  [ "$S" = "202" ] || { echo "  FIXTURE FAIL: register/start -> $S"; return 1; }
  code="$(await_code "$email" "verification code" "$base")"
  [ -n "$code" ] || { echo "  FIXTURE FAIL: no code captured"; return 1; }
  need_code "$code"
  jpost /api/auth/register/complete "$(complete_body "$email" "$code" "$pw" "$role")" -H "Idempotency-Key: $(uuid)"
}
# login <email> <password> -> sets ACCESS and RT (empty when not 200); S is the status
login() {
  jpost /api/auth/login "$(login_body "$1" "$2")"
  ACCESS=""; RT=""
  if [ "$S" = "200" ]; then
    ACCESS="$(jget data.accessToken)"; RT="$(cookie_value)"
    need "$RT"; need "$(printf '%s' "$ACCESS" | cut -d. -f2)"
  fi
}
setup_login() { login "$1" "$2"; [ "$S" = "200" ] || { echo "  FIXTURE FAIL: login -> $S"; exit 2; }; }

claims() { # claims <jwt> -> key=value lines (no signature printed)
  printf '%s' "$1" | python -c '
import base64,json,sys
t=sys.stdin.read().strip().split(".")
def dec(p): return json.loads(base64.urlsafe_b64decode(p+"="*(-len(p)%4)))
h=dec(t[0]);c=dec(t[1])
print("alg="+str(h.get("alg")));print("hkid="+str(h.get("kid")));print("htyp="+str(h.get("typ")))
for k in ("iss","sub","typ","role","status"): print(k+"="+str(c.get(k)))
print("aud="+json.dumps(c.get("aud"),separators=(",",":")))
print("ev="+json.dumps(c.get("ev")));print("subtype="+type(c.get("sub")).__name__)
print("jti_len="+str(len(c.get("jti",""))));print("ttl="+str(c["exp"]-c["iat"]))
print("claim_keys="+",".join(sorted(c.keys())))' | tr -d '\r'
}
claim() { echo "$1" | sed -n "s/^$2=//p"; }

# ----------------------------------------------------------------------------- preflight
section "0. Preflight"
call GET /api/health/ready
if [ "$S" != "200" ]; then
  echo "Server not reachable at $BASE_URL (got $S). Start the QA stack (compose project $COMPOSE_PROJECT):"
  echo "  docker compose -p $COMPOSE_PROJECT up -d --wait   # api, worker, postgres, redis; migrations applied"
  exit 1
fi
echo "  public listener reachable at $BASE_URL"
check "psql fixture access works" "1" "$(psql_q 'SELECT 1')"
check "redis reachable" "PONG" "$($DC exec -T redis redis-cli PING | tr -d '\r')"

EP="qa-patient-$RUN@example.test"
ED="qa-doctor-$RUN@example.test"
ER="qa-rejected-$RUN@example.test"
ES="qa-suspended-$RUN@example.test"
EX="qa-conflict-$RUN@example.test"
EU="qa-unknown-$RUN@example.test"
for e in "$EP" "$ED" "$ER" "$ES" "$EX" "$EU"; do need "$e"; done
need "$PW1"; need "$PW2"; need "$PW3"

# ----------------------------------------------------------------------------- A. register/start
section "A. POST /api/auth/register/start"
flush
BASE_P="$(mail_count "$EP" "verification code")"
jpost /api/auth/register/start "{\"email\":\"$EP\"}"
check "unknown email -> 202" "202" "$S"
check "  empty body" "" "$(cat "$TMP/body")"
check "  Cache-Control" "no-store" "$(no_store)"
SIG_UNKNOWN="$(hdr_sig)"
CODE_P="$(await_code "$EP" "verification code" "$BASE_P")"
need_code "$CODE_P"
check "  worker captured a 6-digit code" "yes" "$([[ "$CODE_P" =~ ^[0-9]{6}$ ]] && echo yes || echo no)"

jpost /api/auth/register/start '{}'
err "missing email -> 400" 400 ValidationFailed email
jpost /api/auth/register/start '{"email":"not-an-email"}'
err "invalid email -> 400" 400 ValidationFailed email
jpost /api/auth/register/start "{\"email\":\"qa-x-$RUN@example.test\",\"role\":\"admin\"}"
err "unknown property -> 400" 400 ValidationFailed role
jpost /api/auth/register/start '{bad'
err "malformed JSON -> 400" 400 ValidationFailed
check "  envelope has requestId + success=false" "false $RID" "$(jget success) $(jget error.requestId)"

# register/start idempotent replay: same key does not queue a second challenge
flush
EI="qa-idem-$RUN@example.test"; need "$EI"
KEY="$(uuid)"
jpost /api/auth/register/start "{\"email\":\"$EI\"}" -H "Idempotency-Key: $KEY"
S1="$S"
jpost /api/auth/register/start "{\"email\":\"$EI\"}" -H "Idempotency-Key: $KEY"
check "register/start same key replayed -> 202 twice" "202 202" "$S1 $S"
check "  only one challenge row for that email" "1" "$(psql_q "SELECT count(*) FROM registration_challenges WHERE email='$EI'")"

# ----------------------------------------------------------------------------- B. register/complete
section "B. POST /api/auth/register/complete"
flush
K1="$(uuid)"
jpost /api/auth/register/complete "$(complete_body "$EP" "$CODE_P" "$PW1" patient)"
err "missing Idempotency-Key -> 400" 400 ValidationFailed Idempotency-Key
jpost /api/auth/register/complete "$(complete_body "$EP" "$CODE_P" "$PW1" patient)" -H "Idempotency-Key: not-a-uuid"
err "non-UUID Idempotency-Key -> 400" 400 ValidationFailed Idempotency-Key
jpost /api/auth/register/complete "$(complete_body "$EP" "12ab56" "$PW1" patient)" -H "Idempotency-Key: $(uuid)"
err "malformed code -> 400 on code" 400 ValidationFailed code
jpost /api/auth/register/complete "$(complete_body "$EP" "$CODE_P" "$PW1" admin)" -H "Idempotency-Key: $(uuid)"
err "role admin refused -> 400 on role" 400 ValidationFailed role
jpost /api/auth/register/complete "$(complete_body "$EP" "$CODE_P" "short" patient)" -H "Idempotency-Key: $(uuid)"
err "short password -> 400 on password" 400 ValidationFailed password
jpost /api/auth/register/complete "$(complete_body "$EP" "$(wrong_code "$CODE_P")" "1234567890" patient)" -H "Idempotency-Key: $(uuid)"
err "denylisted password -> 400 on password" 400 ValidationFailed password
jpost /api/auth/register/complete "{\"email\":\"$EP\",\"code\":\"$CODE_P\",\"password\":\"$PW1\",\"fullName\":\"QA\",\"role\":\"patient\",\"timezone\":\"Mars/Base\",\"locale\":\"en-US\"}" -H "Idempotency-Key: $(uuid)"
err "invalid timezone -> 400 on timezone" 400 ValidationFailed timezone
jpost /api/auth/register/complete "$(complete_body "$EP" "$(wrong_code "$CODE_P")" "$PW1" patient)" -H "Idempotency-Key: $(uuid)"
err "wrong code -> 400 on code" 400 ValidationFailed code

flush   # the validation calls above spent 8 of the 10/h register-complete IP budget
jpost /api/auth/register/complete "$(complete_body "$EP" "$CODE_P" "$PW1" patient +201000000001)" -H "Idempotency-Key: $K1"
check "patient registration -> 201" "201 true" "$S $(jget success)"
check "  role/status/ev" "patient active true" "$(jget data.role) $(jget data.status) $([ -n "$(jget data.emailVerifiedAt)" ] && echo true || echo false)"
check "  Cache-Control" "no-store" "$(no_store)"
check "  no cookie, no token (does not log in)" "no" "$(has_set_cookie)"
check "  no secret fields in body" "0" "$(grep -ciE 'passwordHash|password_hash|accessToken|refreshToken|code_hash' "$TMP/body" || true)"
BODY_201="$(cat "$TMP/body")"
ID_P="$(jget data.id)"
check "  id is numeric" "yes" "$([[ "$ID_P" =~ ^[0-9]+$ ]] && echo yes || echo no)"

jpost /api/auth/register/complete "$(complete_body "$EP" "$CODE_P" "$PW1" patient +201000000001)" -H "Idempotency-Key: $K1"
check "replay same key + same body -> original 201" "201" "$S"
check "  identical body" "$BODY_201" "$(cat "$TMP/body")"
jpost /api/auth/register/complete "$(complete_body "$EP" "$CODE_P" "$PW2" patient +201000000001)" -H "Idempotency-Key: $K1"
err "same key + different body -> 422" 422 IdempotencyConflict
jpost /api/auth/register/complete "$(complete_body "$EP" "$CODE_P" "$PW1" patient)" -H "Idempotency-Key: $(uuid)"
err "consumed code reused, new key -> 400 on code" 400 ValidationFailed code

# known email: identical to unknown (enumeration)
flush
jpost /api/auth/register/start "{\"email\":\"$EP\"}"
check "register/start known email -> 202" "202" "$S"
check "  body identical to unknown email" "" "$(cat "$TMP/body")"
check "  headers identical to unknown email (ex. X-Request-Id, Date)" "$SIG_UNKNOWN" "$(hdr_sig)"
check "  known email gets no challenge row" "1" "$(psql_q "SELECT count(*) FROM registration_challenges WHERE email='$EP'")"

# doctor -> pending
reg_user "$ED" doctor "$PW1"
check "doctor registration -> 201 pending" "201 doctor pending" "$S $(jget data.role) $(jget data.status)"

# rejected-doctor fixture (doctors register as pending; QA sets rejected in SQL)
reg_user "$ER" doctor "$PW1"
check "setup: second doctor registered -> 201" "201" "$S"
psql_q "UPDATE users SET status='rejected' WHERE email='$ER'" >/dev/null
check "  FIXTURE status=rejected" "rejected" "$(psql_q "SELECT status FROM users WHERE email='$ER'")"

# suspended fixture
reg_user "$ES" patient "$PW1"
check "setup: patient to be suspended registered -> 201" "201" "$S"

# duplicate email -> 409: challenge opened while the email is unknown, then the account appears (fixture)
flush
BASE_X="$(mail_count "$EX" "verification code")"
jpost /api/auth/register/start "{\"email\":\"$EX\"}"
CODE_X="$(await_code "$EX" "verification code" "$BASE_X")"; need_code "$CODE_X"
psql_q "INSERT INTO users (email, phone, password_hash, full_name, role, status, email_verified_at, timezone, locale)
        SELECT '$EX', NULL, password_hash, 'QA Race', 'patient', 'active', now(), 'UTC', 'en-US' FROM users WHERE email='$EP'" >/dev/null
jpost /api/auth/register/complete "$(complete_body "$EX" "$CODE_X" "$PW1" patient)" -H "Idempotency-Key: $(uuid)"
err "email registered after the challenge opened -> 409" 409 Conflict

# attempts exhaustion: 5 wrong attempts invalidate the challenge, the 6th (right code) fails too
flush
EE="qa-exhaust-$RUN@example.test"; need "$EE"
BASE_E="$(mail_count "$EE" "verification code")"
jpost /api/auth/register/start "{\"email\":\"$EE\"}"
CODE_E="$(await_code "$EE" "verification code" "$BASE_E")"; need_code "$CODE_E"
BAD_E="$(wrong_code "$CODE_E")"
for i in 1 2 3 4 5; do
  jpost /api/auth/register/complete "$(complete_body "$EE" "$BAD_E" "$PW1" patient)" -H "Idempotency-Key: $(uuid)"
  err "wrong code attempt $i -> 400 on code" 400 ValidationFailed code
done
jpost /api/auth/register/complete "$(complete_body "$EE" "$CODE_E" "$PW1" patient)" -H "Idempotency-Key: $(uuid)"
err "correct code after 5 failures -> 400 on code" 400 ValidationFailed code
check "  no account created" "0" "$(psql_q "SELECT count(*) FROM users WHERE email='$EE'")"

# expired code (fixture: move expires_at into the past)
flush
EV="qa-expired-$RUN@example.test"; need "$EV"
BASE_V="$(mail_count "$EV" "verification code")"
jpost /api/auth/register/start "{\"email\":\"$EV\"}"
CODE_V="$(await_code "$EV" "verification code" "$BASE_V")"; need_code "$CODE_V"
psql_q "UPDATE registration_challenges SET expires_at = now() - interval '1 minute' WHERE email='$EV' AND consumed_at IS NULL" >/dev/null
jpost /api/auth/register/complete "$(complete_body "$EV" "$CODE_V" "$PW1" patient)" -H "Idempotency-Key: $(uuid)"
err "expired code -> 400 on code" 400 ValidationFailed code

# in-flight: two concurrent requests, same key and body
flush
EF="qa-flight-$RUN@example.test"; need "$EF"
BASE_F="$(mail_count "$EF" "verification code")"
jpost /api/auth/register/start "{\"email\":\"$EF\"}"
CODE_F="$(await_code "$EF" "verification code" "$BASE_F")"; need_code "$CODE_F"
KF="$(uuid)"; BODY_F="$(complete_body "$EF" "$CODE_F" "$PW1" patient)"
for n in 1 2; do
  ( curl -s -o "$TMP/f$n.body" -D "$TMP/f$n.hdr" -X POST -H "Content-Type: application/json" -H "Idempotency-Key: $KF" \
      -H "X-Request-Id: $(uuid)" -d "$BODY_F" "$BASE_URL/api/auth/register/complete" -w "%{http_code}" > "$TMP/f$n.code" ) &
done
wait
CODES="$(sort "$TMP/f1.code" "$TMP/f2.code" | tr '\n' ' ' | sed 's/ $//')"
check "two concurrent same-key requests -> one 201 and one 409" "201 409" "$CODES"
LOSER="f1"; [ "$(cat "$TMP/f1.code")" = "409" ] || LOSER="f2"
check "  409 carries Retry-After: 1" "1" "$({ grep -i '^retry-after:' "$TMP/$LOSER.hdr" || true; } | head -1 | cut -d' ' -f2 | tr -d '\r')"
check "  409 envelope code" "Conflict" "$(python -c 'import json,sys;print(json.load(sys.stdin)["error"]["code"])' < "$TMP/$LOSER.body" | tr -d '\r')"

# ----------------------------------------------------------------------------- C. login
section "C. POST /api/auth/login"
flush
JAR="$TMP/jar.txt"
jpost /api/auth/login "$(login_body "$EP" "$PW1")" -c "$JAR"
check "patient login -> 200" "200 true" "$S $(jget success)"
check "  shape: tokenType expiresIn user.id" "Bearer 900 $ID_P" "$(jget data.tokenType) $(jget data.expiresIn) $(jget data.user.id)"
check "  Cache-Control" "no-store" "$(no_store)"
check "  vcare_rt cookie attributes" "vcare_rt=<RT>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=2592000" "$(cookie_shape)"
check "  refresh token never in the body" "0" "$(grep -c "$(cookie_value)" "$TMP/body" || true)"
check "  user object has no secret fields" "0" "$(grep -ciE 'passwordHash|password_hash|refreshToken' "$TMP/body" || true)"
ACCESS_P="$(jget data.accessToken)"; RT_P="$(cookie_value)"
need "$RT_P"; need "$(printf '%s' "$ACCESS_P" | cut -d. -f2)"
check "  curl cookie jar stored vcare_rt (HTTP, Secure attribute)" "yes" "$(grep -q 'vcare_rt' "$JAR" && echo yes || echo no)"
call POST /api/auth/refresh -b "$JAR" -c "$JAR"
check "  refresh using only the curl jar -> 200 (jar works for localhost)" "200" "$S"
check "  jar token rotated (value differs)" "yes" "$([ "$(cookie_value)" != "$RT_P" ] && [ -n "$(cookie_value)" ] && echo yes || echo no)"

jpost /api/auth/login "$(login_body "$EP" "WrongPass-$RUN-zz9")"
err "wrong password -> 401" 401 InvalidCredentials
WRONG_BODY="$(norm)"; WRONG_SIG="$(hdr_sig)"
jpost /api/auth/login "$(login_body "$EU" "WrongPass-$RUN-zz9")"
err "unknown email -> 401" 401 InvalidCredentials
check "  unknown-email body identical to wrong-password body" "$WRONG_BODY" "$(norm)"
check "  unknown-email headers identical" "$WRONG_SIG" "$(hdr_sig)"
check "  no cookie on failure" "no" "$(has_set_cookie)"

jpost /api/auth/login '{"email":"bad"}'
err "invalid email + missing password -> 400" 400 ValidationFailed
jpost /api/auth/login "{\"email\":\"$EU\"}"
err "missing password -> 400" 400 ValidationFailed password
jpost /api/auth/login "{\"email\":\"$EU\",\"password\":\"x\",\"extra\":1}"
err "unknown property -> 400" 400 ValidationFailed extra

# Idempotency-Key is not accepted: ignored, never replayed
KL="$(uuid)"
jpost /api/auth/login "$(login_body "$EP" "$PW1")" -H "Idempotency-Key: $KL"
A1="$(jget data.accessToken)"; R1="$(cookie_value)"; S1="$S"
jpost /api/auth/login "$(login_body "$EP" "$PW1")" -H "Idempotency-Key: $KL"
check "login with Idempotency-Key header ignored: two 200s" "200 200" "$S1 $S"
check "  second login is a new session (token and cookie differ, no replay)" "yes" \
  "$([ "$A1" != "$(jget data.accessToken)" ] && [ "$R1" != "$(cookie_value)" ] && echo yes || echo no)"
check "  no idempotency replay header" "" "$(header Idempotent-Replayed)$(header X-Idempotent-Replay)"

login "$ED" "$PW1"
check "pending doctor login -> 200, token status=pending" "200 pending" "$S $(claim "$(claims "$ACCESS")" status)"
login "$ER" "$PW1"
check "rejected doctor login -> 200, token status=rejected" "200 rejected" "$S $(claim "$(claims "$ACCESS")" status)"
RT_R="$RT"

# suspended: log in first (for later sections), then suspend by SQL
setup_login "$ES" "$PW1"; ACCESS_S="$ACCESS"; RT_S="$RT"
psql_q "UPDATE users SET status='suspended' WHERE email='$ES'" >/dev/null
check "  FIXTURE status=suspended" "suspended" "$(psql_q "SELECT status FROM users WHERE email='$ES'")"
jpost /api/auth/login "$(login_body "$ES" "$PW1")"
err "suspended account login -> 403" 403 AccountSuspended
check "  no cookie set" "no" "$(has_set_cookie)"
jpost /api/auth/login "$(login_body "$ES" "WrongPass-$RUN-zz9")"
err "suspended account + wrong password -> 401 (status not revealed)" 401 InvalidCredentials

# ----------------------------------------------------------------------------- D. token and JWKS
section "D. Access token claims and JWKS"
C="$(claims "$ACCESS_P")"
check "alg" "EdDSA" "$(claim "$C" alg)"
check "header typ" "JWT" "$(claim "$C" htyp)"
check "iss" "vcare-identity" "$(claim "$C" iss)"
check "aud" '["vcare-identity","vcare-care"]' "$(claim "$C" aud)"
check "sub is a string equal to the user id" "str $ID_P" "$(claim "$C" subtype) $(claim "$C" sub)"
check "typ / role / status / ev" "user patient active true" "$(claim "$C" typ) $(claim "$C" role) $(claim "$C" status) $(claim "$C" ev)"
check "jti is a UUID (36 chars)" "36" "$(claim "$C" jti_len)"
check "exp - iat = 900" "900" "$(claim "$C" ttl)"
check "claim set is exactly the documented one" "aud,ev,exp,iat,iss,jti,role,status,sub,typ" \
  "$(claim "$C" claim_keys | tr ',' '\n' | sort | tr '\n' ',' | sed 's/,$//')" || true
KID="$(claim "$C" hkid)"
call GET /.well-known/jwks.json
check "GET /.well-known/jwks.json -> 200" "200" "$S"
check "  Cache-Control" "public, max-age=300" "$(header Cache-Control)"
check "  bare JWK Set (not enveloped)" "ok" "$(grep -q '^{"keys":\[' "$TMP/body" && ! grep -q '"success"' "$TMP/body" && echo ok || echo mismatch)"
check "  token kid is published in the JWKS" "yes" "$(grep -q "\"kid\":\"$KID\"" "$TMP/body" && echo yes || echo no)"
check "  no private key material ('d')" "no" "$(grep -q '"d":' "$TMP/body" && echo yes || echo no)"

# ----------------------------------------------------------------------------- E. refresh
section "E. POST /api/auth/refresh"
flush
setup_login "$EP" "$PW1"; T0="$RT"
call POST /api/auth/refresh -H "$(cookie_hdr "$T0")"
check "rotation -> 200" "200 Bearer 900" "$S $(jget data.tokenType) $(jget data.expiresIn)"
T1="$(cookie_value)"; need "$T1"
check "  new cookie value differs from the old" "yes" "$([ -n "$T1" ] && [ "$T1" != "$T0" ] && echo yes || echo no)"
check "  cookie attributes" "vcare_rt=<RT>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=2592000" "$(cookie_shape)"
check "  Cache-Control" "no-store" "$(no_store)"
check "  new token not in the body" "0" "$(grep -c "$T1" "$TMP/body" || true)"
check "  refreshed access token claims keep sub" "$ID_P" "$(claim "$(claims "$(jget data.accessToken)")" sub)"

call POST /api/auth/refresh -H "$(cookie_hdr "$T0")"
err "grace window: replay of just-rotated token -> 401 RefreshTokenInvalid" 401 RefreshTokenInvalid
check "  grace: NO Set-Cookie" "no" "$(has_set_cookie)"
call POST /api/auth/refresh -H "$(cookie_hdr "$T1")"
check "  grace: family NOT revoked, successor still works -> 200" "200" "$S"
T2="$(cookie_value)"; need "$T2"
echo "  (sleeping $((GRACE_SECONDS + 2)) s to leave the grace window)"
sleep $((GRACE_SECONDS + 2))
call POST /api/auth/refresh -H "$(cookie_hdr "$T0")"
err "reuse after the grace window -> 401 RefreshTokenReused" 401 RefreshTokenReused
check "  clearing Set-Cookie (Max-Age=0)" "vcare_rt=<RT>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0" "$(cookie_shape)"
check "  cleared value is empty" "" "$(cookie_value)"
call POST /api/auth/refresh -H "$(cookie_hdr "$T2")"
err "newest token of the revoked family -> 401 RefreshTokenInvalid" 401 RefreshTokenInvalid
check "  clearing Set-Cookie on failure" "vcare_rt=<RT>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0" "$(cookie_shape)"

call POST /api/auth/refresh
err "no cookie -> 401 RefreshTokenInvalid" 401 RefreshTokenInvalid
check "  clearing Set-Cookie" "yes" "$([ "$(cookie_shape)" = "vcare_rt=<RT>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0" ] && echo yes || echo no)"
call POST /api/auth/refresh -H "$(cookie_hdr "garbage")"
err "garbage cookie -> 401 RefreshTokenInvalid" 401 RefreshTokenInvalid
call POST /api/auth/refresh -H "$(cookie_hdr "$(printf 'A%.0s' $(seq 1 43))")"
err "well-formed but unknown token -> 401 RefreshTokenInvalid" 401 RefreshTokenInvalid

# expired token (fixture: age the live row)
setup_login "$EP" "$PW1"; TE="$RT"
psql_q "UPDATE refresh_tokens SET created_at = now() - interval '40 days', expires_at = now() - interval '1 day'
        WHERE user_id = $ID_P AND revoked_at IS NULL AND token_hash = encode(sha256(convert_to('$TE','UTF8')),'hex')" >/dev/null
call POST /api/auth/refresh -H "$(cookie_hdr "$TE")"
err "expired refresh token (fixture) -> 401 RefreshTokenInvalid" 401 RefreshTokenInvalid

setup_login "$ER" "$PW1"
call POST /api/auth/refresh -H "$(cookie_hdr "$RT")"
check "rejected account can refresh -> 200, token status=rejected" "200 rejected" "$S $(claim "$(claims "$(jget data.accessToken)")" status)"
setup_login "$ED" "$PW1"
call POST /api/auth/refresh -H "$(cookie_hdr "$RT")"
check "pending account can refresh -> 200, token status=pending" "200 pending" "$S $(claim "$(claims "$(jget data.accessToken)")" status)"

# suspended: the cookie obtained before suspension (section C)
call POST /api/auth/refresh -H "$(cookie_hdr "$RT_S")"
err "suspended account refresh -> 403 AccountSuspended" 403 AccountSuspended
check "  clearing Set-Cookie" "vcare_rt=<RT>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0" "$(cookie_shape)"
call POST /api/auth/refresh -H "$(cookie_hdr "$RT_S")"
err "  family revoked: same cookie again -> 401 RefreshTokenInvalid" 401 RefreshTokenInvalid
check "  no live refresh token left for the suspended user" "0" "$(psql_q "SELECT count(*) FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id WHERE u.email='$ES' AND rt.revoked_at IS NULL")"

# ----------------------------------------------------------------------------- F. logout
section "F. POST /api/auth/logout"
flush
setup_login "$EP" "$PW1"; TL="$RT"
call POST /api/auth/logout -H "$(cookie_hdr "$TL")"
check "logout with cookie -> 204" "204" "$S"
check "  empty body" "" "$(cat "$TMP/body")"
check "  clearing cookie" "vcare_rt=<RT>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0" "$(cookie_shape)"
check "  Cache-Control" "no-store" "$(no_store)"
call POST /api/auth/refresh -H "$(cookie_hdr "$TL")"
err "  refresh with the logged-out cookie -> 401 RefreshTokenInvalid" 401 RefreshTokenInvalid
call POST /api/auth/logout -H "$(cookie_hdr "$TL")"
check "logout again with the revoked cookie -> 204" "204" "$S"
call POST /api/auth/logout
check "logout without cookie -> 204 (idempotent)" "204" "$S"
check "  clearing cookie sent" "yes" "$([ "$(cookie_shape)" = "vcare_rt=<RT>; HttpOnly; Secure; SameSite=Strict; Path=/api/auth; Max-Age=0" ] && echo yes || echo no)"
call POST /api/auth/logout -H "$(cookie_hdr "garbage")"
check "logout with garbage cookie -> 204" "204" "$S"

# ----------------------------------------------------------------------------- I. me
section "G. GET /api/auth/me and PATCH /api/auth/me"
flush
setup_login "$EP" "$PW1"; AP="$ACCESS"; RP="$RT"
call GET /api/auth/me -H "$(bearer "$AP")"
check "GET /me -> 200" "200 true $ID_P patient" "$S $(jget success) $(jget data.id) $(jget data.role)"
check "  Cache-Control" "no-store" "$(no_store)"
check "  response has exactly the 12 User fields" "avatarUrl,createdAt,email,emailVerifiedAt,fullName,id,locale,phone,role,status,timezone,updatedAt"   "$(python -c 'import json,sys;print(",".join(sorted(json.load(sys.stdin)["data"].keys())))' < "$TMP/body" | tr -d '\r')"
check "  no passwordHash or token fields" "0" "$(grep -ciE 'passwordHash|password_hash|token|hash' "$TMP/body" || true)"

call GET /api/auth/me
err "GET /me without token -> 401" 401 Unauthorized
call GET /api/auth/me -H "$(bearer "not.a.jwt")"
err "GET /me with garbage token -> 401" 401 Unauthorized
TAMPERED="$(printf '%s' "$AP" | python -c 'import sys;h,p,g=sys.stdin.read().strip().split(".");print(h+"."+p+"."+("B" if g[0]=="A" else "A")+g[1:])' | tr -d '\r')"  # first signature char carries 6 full bits; the last char of a 64-byte signature carries padding bits
call GET /api/auth/me -H "$(bearer "$TAMPERED")"
err "GET /me with tampered signature -> 401" 401 Unauthorized
call GET /api/auth/me -H "Authorization: Basic abc"
err "GET /me with wrong scheme -> 401" 401 Unauthorized
call GET /api/auth/me -H "$(bearer "$RP")"
err "GET /me with a refresh token as bearer -> 401" 401 Unauthorized

jpatch /api/auth/me '{"fullName":"QA Renamed","phone":"+201000000002","avatarUrl":"https://example.test/a.png","timezone":"africa/cairo","locale":"ar-eg"}' -H "$(bearer "$AP")"
check "PATCH /me all five fields -> 200" "200 QA Renamed +201000000002" "$S $(jget data.fullName) $(jget data.phone)"
check "  timezone/locale stored canonical" "Africa/Cairo ar-EG" "$(jget data.timezone) $(jget data.locale)"
jpatch /api/auth/me '{"phone":null,"avatarUrl":null}' -H "$(bearer "$AP")"
check "PATCH /me null clears phone and avatarUrl" "200  " "$S $(jget data.phone) $(jget data.avatarUrl)"
jpatch /api/auth/me '{"email":"qa-new-'"$RUN"'@example.test"}' -H "$(bearer "$AP")"
err "PATCH email -> 400 on email" 400 ValidationFailed email
jpatch /api/auth/me '{"role":"admin"}' -H "$(bearer "$AP")"
err "PATCH role -> 400 on role" 400 ValidationFailed role
jpatch /api/auth/me '{"status":"active"}' -H "$(bearer "$AP")"
err "PATCH status -> 400 on status" 400 ValidationFailed status
jpatch /api/auth/me '{}' -H "$(bearer "$AP")"
err "PATCH empty body -> 400" 400 ValidationFailed body
jpatch /api/auth/me '{"timezone":"Mars/Base"}' -H "$(bearer "$AP")"
err "PATCH invalid timezone -> 400 on timezone" 400 ValidationFailed timezone
jpatch /api/auth/me '{"locale":"not a locale!"}' -H "$(bearer "$AP")"
err "PATCH invalid locale -> 400 on locale" 400 ValidationFailed locale
jpatch /api/auth/me '{"fullName":null}' -H "$(bearer "$AP")"
err "PATCH fullName null -> 400 on fullName" 400 ValidationFailed fullName
jpatch /api/auth/me '{"fullName":"   "}' -H "$(bearer "$AP")"
err "PATCH blank fullName -> 400 on fullName" 400 ValidationFailed fullName
jpatch /api/auth/me '{"avatarUrl":"not a url"}' -H "$(bearer "$AP")"
err "PATCH invalid avatarUrl -> 400 on avatarUrl" 400 ValidationFailed avatarUrl
jpatch /api/auth/me '{"phone":"0123"}' -H "$(bearer "$AP")"
err "PATCH non-E.164 phone -> 400 on phone" 400 ValidationFailed phone
jpatch /api/auth/me '{"fullName":"X"}'
err "PATCH without token -> 401" 401 Unauthorized

# reviewer suspicion: a fixed UTC offset is not an IANA zone
jpatch /api/auth/me '{"timezone":"+01:00"}' -H "$(bearer "$AP")"
err "PATCH timezone \"+01:00\" (offset, not IANA) -> 400 on timezone" 400 ValidationFailed timezone
echo "        (observed: status $S, stored timezone '$(jget data.timezone)')"
jpatch /api/auth/me '{"timezone":"Africa/Cairo"}' -H "$(bearer "$AP")"

# ----------------------------------------------------------------------------- H. forgot / reset
section "H. POST /api/auth/forgot-password and /api/auth/reset-password"
flush
setup_login "$EP" "$PW1"; RT_OLD="$RT"; RT_OLD2=""
login "$EP" "$PW1"; RT_OLD2="$RT"
BASE_R="$(mail_count "$EP" "reset")"
jpost /api/auth/forgot-password "{\"email\":\"$EP\"}"
check "forgot-password known email -> 204" "204" "$S"
check "  empty body, no-store" "|no-store" "$(cat "$TMP/body")|$(no_store)"
SIG_FK="$(hdr_sig)"
jpost /api/auth/forgot-password "{\"email\":\"$EU\"}"
check "forgot-password unknown email -> 204" "204" "$S"
check "  headers identical to known email" "$SIG_FK" "$(hdr_sig)"
jpost /api/auth/forgot-password '{"email":"nope"}'
err "forgot-password invalid email -> 400" 400 ValidationFailed email
jpost /api/auth/forgot-password '{}'
err "forgot-password missing email -> 400" 400 ValidationFailed email
CODE_R="$(await_code "$EP" "reset" "$BASE_R")"; need_code "$CODE_R"
check "  worker captured a 6-digit reset code (unknown email got none)" "yes 0" \
  "$([[ "$CODE_R" =~ ^[0-9]{6}$ ]] && echo yes || echo no) $(mail_count "$EU" "reset")"

jpost /api/auth/reset-password "{\"email\":\"$EP\",\"code\":\"$(wrong_code "$CODE_R")\",\"newPassword\":\"$PW2\"}"
err "reset wrong code -> 400 on code" 400 ValidationFailed code
WRONG_RESET="$(norm)"
jpost /api/auth/reset-password "{\"email\":\"$EU\",\"code\":\"$CODE_R\",\"newPassword\":\"$PW2\"}"
err "reset unknown email -> 400 on code" 400 ValidationFailed code
check "  body identical to the wrong-code body (no enumeration)" "$WRONG_RESET" "$(norm)"
jpost /api/auth/reset-password "{\"email\":\"$EP\",\"code\":\"$CODE_R\",\"newPassword\":\"1234567890\"}"
err "reset denylisted password -> 400 on newPassword" 400 ValidationFailed newPassword
jpost /api/auth/reset-password "{\"email\":\"$EP\",\"code\":\"$CODE_R\",\"newPassword\":\"short\"}"
err "reset short password -> 400 on newPassword" 400 ValidationFailed newPassword
jpost /api/auth/reset-password "{\"email\":\"$EP\",\"code\":\"12\",\"newPassword\":\"$PW2\"}"
err "reset malformed code -> 400 on code" 400 ValidationFailed code
jpost /api/auth/reset-password "{\"email\":\"$EP\",\"code\":\"$CODE_R\",\"newPassword\":\"$PW2\"}"
check "reset right code -> 204" "204" "$S"
check "  Cache-Control" "no-store" "$(no_store)"
call POST /api/auth/refresh -H "$(cookie_hdr "$RT_OLD")"
err "  refresh family 1 revoked -> 401 RefreshTokenInvalid" 401 RefreshTokenInvalid
call POST /api/auth/refresh -H "$(cookie_hdr "$RT_OLD2")"
err "  refresh family 2 revoked -> 401 RefreshTokenInvalid" 401 RefreshTokenInvalid
jpost /api/auth/login "$(login_body "$EP" "$PW1")"
err "  old password no longer works -> 401" 401 InvalidCredentials
login "$EP" "$PW2"
check "  new password works -> 200" "200" "$S"
flush
jpost /api/auth/reset-password "{\"email\":\"$EP\",\"code\":\"$CODE_R\",\"newPassword\":\"$PW3\"}"
err "code is single use -> 400 on code" 400 ValidationFailed code

# attempts cap: 5 wrong -> invalidated; limiter cleared so the 6th attempt reaches the row
flush
BASE_R2="$(mail_count "$EP" "reset")"
jpost /api/auth/forgot-password "{\"email\":\"$EP\"}"
CODE_R2="$(await_code "$EP" "reset" "$BASE_R2")"; need_code "$CODE_R2"
BAD_R2="$(wrong_code "$CODE_R2")"
for i in 1 2 3 4 5; do
  jpost /api/auth/reset-password "{\"email\":\"$EP\",\"code\":\"$BAD_R2\",\"newPassword\":\"$PW3\"}"
  err "reset wrong code attempt $i -> 400 on code" 400 ValidationFailed code
done
flush
jpost /api/auth/reset-password "{\"email\":\"$EP\",\"code\":\"$CODE_R2\",\"newPassword\":\"$PW3\"}"
err "right code after 5 failures (limiter cleared) -> 400 on code" 400 ValidationFailed code
jpost /api/auth/login "$(login_body "$EP" "$PW2")"
check "  password unchanged by the exhausted reset" "200" "$S"

# expired reset code (fixture)
flush
BASE_R3="$(mail_count "$EP" "reset")"
jpost /api/auth/forgot-password "{\"email\":\"$EP\"}"
CODE_R3="$(await_code "$EP" "reset" "$BASE_R3")"; need_code "$CODE_R3"
psql_q "UPDATE password_resets SET expires_at = now() - interval '1 minute' WHERE user_id=$ID_P AND used_at IS NULL AND invalidated_at IS NULL" >/dev/null
jpost /api/auth/reset-password "{\"email\":\"$EP\",\"code\":\"$CODE_R3\",\"newPassword\":\"$PW3\"}"
err "expired reset code (fixture) -> 400 on code" 400 ValidationFailed code

# ----------------------------------------------------------------------------- I. change-password
section "I. POST /api/auth/change-password"
flush
setup_login "$EP" "$PW2"; AC="$ACCESS"; RC="$RT"
login "$EP" "$PW2"; RC2="$RT"
call POST /api/auth/change-password -H "Content-Type: application/json" -d "{\"currentPassword\":\"$PW2\",\"newPassword\":\"$PW3\"}"
err "without bearer -> 401" 401 Unauthorized
jpost /api/auth/change-password "{\"currentPassword\":\"WrongPass-$RUN-zz9\",\"newPassword\":\"$PW3\"}" -H "$(bearer "$AC")"
err "wrong current password -> 401 InvalidCredentials" 401 InvalidCredentials
jpost /api/auth/change-password "{\"currentPassword\":\"$PW2\",\"newPassword\":\"1234567890\"}" -H "$(bearer "$AC")"
err "denylisted new password -> 400 on newPassword" 400 ValidationFailed newPassword
jpost /api/auth/change-password "{\"newPassword\":\"$PW3\"}" -H "$(bearer "$AC")"
err "missing currentPassword -> 400 on currentPassword" 400 ValidationFailed currentPassword
jpost /api/auth/change-password "{\"currentPassword\":\"$PW2\",\"newPassword\":\"$PW3\"}" -H "$(bearer "$AC")" -H "$(cookie_hdr "$RC")"
check "success with own cookie -> 204" "204" "$S"
check "  cookie untouched" "no" "$(has_set_cookie)"
call POST /api/auth/refresh -H "$(cookie_hdr "$RC")"
check "  caller's own family still works -> 200" "200" "$S"
RC="$(cookie_value)"
call POST /api/auth/refresh -H "$(cookie_hdr "$RC2")"
err "  the other family was revoked -> 401" 401 RefreshTokenInvalid
jpost /api/auth/login "$(login_body "$EP" "$PW2")"
err "  old password rejected -> 401" 401 InvalidCredentials
login "$EP" "$PW3"
check "  new password works -> 200" "200" "$S"
RC3="$RT"
jpost /api/auth/change-password "{\"currentPassword\":\"$PW3\",\"newPassword\":\"$PW2\"}" -H "$(bearer "$AC")"
check "change without cookie -> 204 (all families revoked)" "204" "$S"
call POST /api/auth/refresh -H "$(cookie_hdr "$RC3")"
err "  every family revoked when no cookie is sent -> 401" 401 RefreshTokenInvalid

# ----------------------------------------------------------------------------- J. suspended account on authenticated routes
section "J. Suspended account on authenticated routes"
call GET /api/auth/me -H "$(bearer "$ACCESS_S")"
err "GET /me, token issued before suspension -> 403 AccountSuspended" 403 AccountSuspended
jpatch /api/auth/me '{"fullName":"Nope"}' -H "$(bearer "$ACCESS_S")"
err "PATCH /me suspended -> 403 AccountSuspended" 403 AccountSuspended
jpost /api/auth/change-password "{\"currentPassword\":\"$PW1\",\"newPassword\":\"$PW3\"}" -H "$(bearer "$ACCESS_S")"
err "change-password suspended -> 403 AccountSuspended" 403 AccountSuspended
setup_login "$ER" "$PW1"
call GET /api/auth/me -H "$(bearer "$ACCESS")"
check "rejected account GET /me -> 200" "200 rejected" "$S $(jget data.status)"
setup_login "$ED" "$PW1"
call GET /api/auth/me -H "$(bearer "$ACCESS")"
check "pending account GET /me -> 200" "200 pending" "$S $(jget data.status)"

# ----------------------------------------------------------------------------- K. cross-cutting
section "K. Cross-cutting: headers, request id, envelope"
SENT="$(uuid)"
curl -s -o "$TMP/body" -D "$TMP/headers" -H "X-Request-Id: $SENT" "$BASE_URL/api/auth/nope" >/dev/null
check "unknown /api/auth path echoes a valid UUID" "$SENT" "$(header X-Request-Id)"
check "  unknown /api/auth path -> envelope NotFound + requestId" "NotFound $SENT" "$(jget error.code) $(jget error.requestId)"
check "  unknown /api/auth path Cache-Control" "no-store" "$(no_store)"
curl -s -o "$TMP/body" -D "$TMP/headers" -H "X-Request-Id: not-a-uuid" "$BASE_URL/api/auth/me" >/dev/null
check "invalid X-Request-Id is regenerated" "regenerated" "$([ -n "$(header X-Request-Id)" ] && [ "$(header X-Request-Id)" != "not-a-uuid" ] && echo regenerated || echo echoed)"
check "  regenerated id equals error.requestId" "$(header X-Request-Id)" "$(jget error.requestId)"
call GET /api/nope
err "unknown /api path -> 404 NotFound" 404 NotFound
check "  success=false and requestId == header" "false $RID" "$(jget success) $(jget error.requestId)"

call POST /api/auth/login -H "Content-Type: application/json" -d '{bad'
err "malformed JSON POST /api/auth/login -> 400" 400 ValidationFailed
check "  Cache-Control: no-store on the malformed-JSON error" "no-store" "$(no_store)"
call OPTIONS /api/auth/login
echo "        (observed OPTIONS /api/auth/login: status $S, Cache-Control '$(no_store)')"
check "OPTIONS /api/auth/login carries Cache-Control: no-store" "no-store" "$(no_store)"
call GET /api/auth/login
echo "        (observed GET /api/auth/login: status $S, code $(jget error.code))"
check "GET on a POST-only auth route -> 404 envelope with no-store" "404 NotFound no-store" "$S $(jget error.code) $(no_store)"
call POST /api/auth/login -H "Content-Type: text/plain" -d 'x'
echo "        (observed text/plain login: status $S, code $(jget error.code))"
check "401 response carries no-store" "no-store" "$(call GET /api/auth/me; no_store)"

# ----------------------------------------------------------------------------- L. rate limits
section "L. Rate limits (each group starts from a flushed Redis)"
retry_after() { header Retry-After; }
rl_check() { # rl_check <label> <expected 429 index> <first 429 index> ; reads $TMP/headers of that 429
  check "$1" "$2" "$3"
}
rl429() { # after a 429: envelope, headers
  check "  429 envelope" "RateLimited false $RID" "$(jget error.code) $(jget success) $(jget error.requestId)"
  check "  429 Cache-Control: no-store" "no-store" "$(no_store)"
  echo "        (observed Retry-After: '$(retry_after)')"
  check "  429 has Retry-After (positive integer)" "yes" "$([[ "$(retry_after)" =~ ^[1-9][0-9]*$ ]] && echo yes || echo no)"
}

flush
ELR="qa-rl-login-$RUN@example.test"; need "$ELR"
FIRST=0
for i in $(seq 1 8); do
  jpost /api/auth/login "$(login_body "$ELR" "WrongPass-$RUN-zz9")"
  if [ "$S" = "429" ] && [ "$FIRST" = 0 ]; then FIRST=$i; break; fi
done
check "login 5/min per IP+email: first 429 on attempt 6" "6" "$FIRST"
rl429

flush
FIRST=0
for i in $(seq 1 25); do
  jpost /api/auth/login "$(login_body "qa-rl-ip-$i-$RUN@example.test" "WrongPass-$RUN-zz9")"
  if [ "$S" = "429" ]; then FIRST=$i; break; fi
done
check "login 20/min per IP: first 429 on attempt 21" "21" "$FIRST"
rl429

flush
ERS="qa-rl-start-$RUN@example.test"; need "$ERS"
FIRST=0
for i in 1 2 3 4 5; do
  jpost /api/auth/register/start "{\"email\":\"$ERS\"}"
  if [ "$S" = "429" ]; then FIRST=$i; break; fi
done
check "register/start 3/h per email: first 429 on attempt 4" "4" "$FIRST"
rl429

flush
FIRST=0
for i in 1 2 3 4 5 6 7; do
  jpost /api/auth/register/start "{\"email\":\"qa-rl-s$i-$RUN@example.test\"}"
  if [ "$S" = "429" ]; then FIRST=$i; break; fi
done
check "register/start 5/h per IP: first 429 on attempt 6" "6" "$FIRST"
rl429

flush
FIRST=0
for i in $(seq 1 13); do
  jpost /api/auth/register/complete "$(complete_body "qa-rl-c$i-$RUN@example.test" "123456" "$PW1" patient)" -H "Idempotency-Key: $(uuid)"
  if [ "$S" = "429" ]; then FIRST=$i; break; fi
done
check "register/complete 10/h per IP: first 429 on attempt 11" "11" "$FIRST"
rl429

flush
FIRST=0
for i in 1 2 3 4 5; do
  jpost /api/auth/forgot-password "{\"email\":\"$ERS\"}"
  if [ "$S" = "429" ]; then FIRST=$i; break; fi
done
check "forgot-password 3/h per email: first 429 on attempt 4" "4" "$FIRST"
rl429

flush
FIRST=0
for i in 1 2 3 4 5 6 7; do
  jpost /api/auth/reset-password "{\"email\":\"$ERS\",\"code\":\"123456\",\"newPassword\":\"$PW1\"}"
  if [ "$S" = "429" ]; then FIRST=$i; break; fi
done
check "reset-password 5/h per email: first 429 on attempt 6" "6" "$FIRST"
rl429

flush
FIRST=0
for i in $(seq 1 12); do
  jpost /api/auth/reset-password "{\"email\":\"qa-rl-r$i-$RUN@example.test\",\"code\":\"123456\",\"newPassword\":\"$PW1\"}"
  if [ "$S" = "429" ]; then FIRST=$i; break; fi
done
check "reset-password 10/h per IP: first 429 on attempt 11" "11" "$FIRST"
rl429

flush
setup_login "$EP" "$PW2"; AR="$ACCESS"
FIRST=0
for i in 1 2 3 4 5 6 7; do
  jpost /api/auth/change-password "{\"currentPassword\":\"WrongPass-$RUN-zz9\",\"newPassword\":\"$PW3\"}" -H "$(bearer "$AR")"
  if [ "$S" = "429" ]; then FIRST=$i; break; fi
done
check "change-password 5 per 15 min per user: first 429 on attempt 6" "6" "$FIRST"
rl429

flush
setup_login "$EP" "$PW2"; TR="$RT"
FIRST=0; SETCK="n/a"
for i in $(seq 1 34); do
  call POST /api/auth/refresh -H "$(cookie_hdr "$TR")"
  if [ "$S" = "429" ]; then FIRST=$i; SETCK="$(has_set_cookie)"; break; fi
  TR="$(cookie_value)"; need "$TR"
done
check "refresh 30/min per family: first 429 on attempt 31" "31" "$FIRST"
rl429
check "  429 leaves the cookie untouched (no Set-Cookie)" "no" "$SETCK"
flush

# ----------------------------------------------------------------------------- M. logs and outbox
section "M. Secrets and PII in logs; outbox rows"
if [ "$RUN_LOG_SCAN" = "1" ]; then
  $DC logs --no-color api worker > "$TMP/logs" 2>&1 || true
  LINES="$(wc -l < "$TMP/logs" | tr -d ' ')"
  echo "  scanned $LINES log lines from api + worker"
  check "no test email, code, token, refresh token or password in api/worker logs (count of matching lines)" "0" \
    "$(grep -F -c -f "$TMP/needles" "$TMP/logs" || true)"
  check "no one-time code as a whole word in api/worker logs (count of matching lines)" "0" \
    "$(grep -F -w -c -f "$TMP/codes" "$TMP/logs" || true)"
  check "no Authorization/Cookie header or 'Bearer ' value in logs" "0" "$(grep -ciE 'authorization|bearer [A-Za-z0-9_-]{20}|vcare_rt=' "$TMP/logs" || true)"
  check "no password / passwordHash / token JSON keys in logs" "0" "$(grep -ciE '"(password|newPassword|currentPassword|passwordHash|password_hash|accessToken|refreshToken|code)"' "$TMP/logs" || true)"
  check "no email-shaped string at all in logs" "0" "$(grep -ciE '[A-Za-z0-9._-]+@example\.test' "$TMP/logs" || true)"
else
  echo "  RUN_LOG_SCAN=0, skipped"
fi
check "outbox_jobs columns hold ids/state only" "id,type,aggregate_id,status,attempts,run_after,locked_until,last_error,request_id,created_at,updated_at,completed_at" \
  "$(psql_q "SELECT string_agg(column_name, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_name='outbox_jobs'")"
check "outbox rows: no '@' anywhere, last_error is a short class name or NULL" "0" \
  "$(psql_q "SELECT count(*) FROM outbox_jobs WHERE last_error ~ '@' OR length(coalesce(last_error,'')) > 64 OR type !~ '^[a-z_]+\$'")"
check "no dead outbox jobs created by this run" "0" "$(psql_q "SELECT count(*) FROM outbox_jobs WHERE status='dead' AND created_at > now() - interval '2 hours'")"

# ----------------------------------------------------------------------------- summary
section "Summary"
echo "  X-Request-Id echoed on $RID_OK calls, missing/mismatched on $RID_BAD calls"
check "X-Request-Id echoed on every helper call" "0" "$RID_BAD"
printf "\n=== Result: %s pass / %s fail ===\n" "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
