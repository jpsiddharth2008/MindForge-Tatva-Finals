#!/usr/bin/env bash
# Brings the whole MindForge stack up with one command, and takes it down with Ctrl+C.
#
#   ./dev.sh
#
# Starts, in dependency order:
#   1. MongoDB            docker, port 27017
#   2. Hardhat chain      port 8545, chain 31337
#   3. deploy + register  CredentialRegistry, one issuer on, one wallet off
#   4. backend            port 5001
#   5. frontend           port 5173
#
# WHY THE CONTRACT IS REDEPLOYED EVERY RUN. Hardhat's node keeps its chain in
# memory, so stopping it erases every anchored document. Redeploying on each
# start is therefore not waste, it is the only way the backend's CONTRACT_ADDRESS
# can be true.
#
# The address is NOT stable. It is derived from the deployer and its nonce, so a
# fresh node always gives 0x5FbDB2…, but redeploying onto a node that is already
# running gives a different address every time. That is exactly why sync_env
# below rewrites the .env files instead of trusting a hardcoded value.
#
# Mongo is the exception: its container has a volume, so issued records DO
# survive. After a restart you can have records referring to a chain that no
# longer knows them - documents stuck short of ISSUED. Re-issue them; see the
# warning printed at the end.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOGS="$ROOT/logs"
mkdir -p "$LOGS"

# Neither default is usable on this machine: an unrelated containerised app
# (/app/node_modules/.bin/vite) permanently holds 5000 and 5173. Override with
# BACKEND_PORT=… FRONTEND_PORT=… ./dev.sh on a machine where the defaults are free.
BACKEND_PORT="${BACKEND_PORT:-5001}"       # not 5000
FRONTEND_PORT="${FRONTEND_PORT:-5174}"     # not 5173
RPC=http://127.0.0.1:8545
CHAIN_ID=31337
# Hardhat account #0. Publicly known test key, worthless outside this local node.
ISSUER_ADDR=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
ISSUER_NAME="NIT Calicut — Registrar"
OUTSIDER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8

PIDS=()
say()  { printf '\n\033[1;36m== %s\033[0m\n' "$*"; }
ok()   { printf '   \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '   \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*"; exit 1; }

cleanup() {
  # Only claim to have stopped things this script actually started: a preflight
  # failure must not look like it tore down processes already running.
  [ ${#PIDS[@]} -eq 0 ] && return
  printf '\n\033[1;36m== shutting down\033[0m\n'
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  ok "stopped the ${#PIDS[@]} process(es) this script started"
  warn "MongoDB container left running (docker stop mindforge-mongo)"
}
trap cleanup EXIT INT TERM

# Waits for a condition instead of sleeping a guessed number of seconds.
wait_for() {
  local label="$1" seconds="$2"; shift 2
  for ((i = 1; i <= seconds; i++)); do
    if "$@" >/dev/null 2>&1; then ok "$label (${i}s)"; return 0; fi
    sleep 1
  done
  die "$label did not come up in ${seconds}s - see $LOGS"
}

port_busy() { ss -ltn 2>/dev/null | grep -q ":$1 "; }

# ---------------------------------------------------------------- preflight
say "preflight"
for c in docker node npm curl; do command -v "$c" >/dev/null || die "$c is not installed"; done
[ -f "$ROOT/backend/.env" ]  || die "backend/.env is missing"
[ -d "$ROOT/backend/node_modules" ]    || die "run: cd backend && npm install"
[ -d "$ROOT/frontend/node_modules" ]   || die "run: cd frontend && npm install"
[ -d "$ROOT/blockchain/node_modules" ] || die "run: cd blockchain && npm install"
port_busy "$BACKEND_PORT"  && die "port $BACKEND_PORT is already in use"
port_busy "$FRONTEND_PORT" && die "port $FRONTEND_PORT is already in use"
ok "tools, dependencies and ports"

# ------------------------------------------------------------------- mongo
say "MongoDB"
if docker ps --format '{{.Names}}' | grep -qx mindforge-mongo; then
  ok "already running"
elif docker ps -a --format '{{.Names}}' | grep -qx mindforge-mongo; then
  docker start mindforge-mongo >/dev/null || die "could not start the mindforge-mongo container"
  ok "container restarted"
else
  docker run -d --name mindforge-mongo -p 27017:27017 --restart unless-stopped mongo:7 >/dev/null \
    || die "could not create the mongo container"
  ok "container created (mongo:7)"
fi
wait_for "accepting connections" 90 \
  bash -c "docker exec mindforge-mongo mongosh --quiet --eval 'db.runCommand({ping:1}).ok' | grep -q 1"

# ------------------------------------------------------------------- chain
say "Hardhat chain"
if port_busy 8545; then
  warn "something already listens on 8545 - reusing it"
else
  ( cd "$ROOT/blockchain" && exec npx hardhat node ) > "$LOGS/chain.log" 2>&1 &
  PIDS+=($!)
  wait_for "node up on 8545" 60 \
    bash -c "curl -s -m 2 -X POST $RPC -H 'Content-Type: application/json' \
      -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_chainId\",\"params\":[]}' | grep -q 0x7a69"
fi

say "contract"
( cd "$ROOT/blockchain" && npm run deploy:local ) > "$LOGS/deploy.log" 2>&1 \
  || { tail -20 "$LOGS/deploy.log"; die "deploy failed"; }
ADDRESS=$(node -e "process.stdout.write(require('$ROOT/blockchain/deployments/localhost.json').address)")
ok "deployed at $ADDRESS"

( cd "$ROOT/blockchain" && ISSUERS="$ISSUER_ADDR=$ISSUER_NAME" \
    npx hardhat run scripts/register-issuer.js --network localhost ) > "$LOGS/issuer.log" 2>&1 \
  || { tail -20 "$LOGS/issuer.log"; die "registering the issuer failed"; }
ok "issuer registered   $ISSUER_ADDR"
ok "outsider left off   $OUTSIDER_ADDR  (anchoring from it must revert)"

# ------------------------------------------------- keep the .env files true
# Only rewritten when the address actually changed, and never without a backup:
# these files hold live credentials.
sync_env() {
  local file="$1" key="$2" value="$3"
  [ -f "$file" ] || { warn "$(basename "$(dirname "$file")")/.env missing; skipping $key"; return; }
  if grep -q "^$key=$value$" "$file"; then return; fi
  cp "$file" "$file.backup-$(date +%Y%m%d-%H%M%S)"
  if grep -q "^$key=" "$file"; then
    sed -i "s|^$key=.*|$key=$value|" "$file"
  else
    printf '%s=%s\n' "$key" "$value" >> "$file"
  fi
  warn "updated $key in $(basename "$(dirname "$file")")/.env (backup written)"
}
sync_env "$ROOT/backend/.env"  CONTRACT_ADDRESS      "$ADDRESS"
sync_env "$ROOT/backend/.env"  CHAIN_ID              "$CHAIN_ID"
sync_env "$ROOT/backend/.env"  RPC_URL               "$RPC"
sync_env "$ROOT/backend/.env"  PORT                  "$BACKEND_PORT"
# CORS_ORIGINS is an EXACT-match allowlist (security.js). If the frontend port
# changes and this does not, every API call from the browser is blocked - and it
# fails as an opaque network error, not as an obvious CORS message.
sync_env "$ROOT/backend/.env"  CORS_ORIGINS          "http://localhost:$FRONTEND_PORT"
sync_env "$ROOT/frontend/.env" VITE_CONTRACT_ADDRESS "$ADDRESS"
sync_env "$ROOT/frontend/.env" VITE_CHAIN_ID         "$CHAIN_ID"
sync_env "$ROOT/frontend/.env" VITE_API_URL          "http://localhost:$BACKEND_PORT"

# ----------------------------------------------------------------- backend
say "backend"
( cd "$ROOT/backend" && exec npm start ) > "$LOGS/backend.log" 2>&1 &
PIDS+=($!)
wait_for "listening on $BACKEND_PORT" 60 \
  bash -c "curl -s -m 2 localhost:$BACKEND_PORT/api/health | grep -q '\"status\"'"

HEALTH=$(curl -s "localhost:$BACKEND_PORT/api/health")
echo "$HEALTH" | grep -q '"mongodb":"ok"' && ok "mongodb"  || warn "mongodb NOT ok"
echo "$HEALTH" | grep -q '"s3_config":"ok"' && ok "s3"     || warn "s3 NOT ok - issuing will fail"
echo "$HEALTH" | grep -q '"contract":"ok"' && ok "contract" || warn "contract NOT ok"

# ---------------------------------------------------------------- frontend
say "frontend"
# Vite reads .env only at startup, which is why it is started AFTER sync_env.
( cd "$ROOT/frontend" && exec npm run dev -- --port "$FRONTEND_PORT" ) > "$LOGS/frontend.log" 2>&1 &
PIDS+=($!)
wait_for "listening on $FRONTEND_PORT" 60 \
  bash -c "curl -s -m 2 -o /dev/null localhost:$FRONTEND_PORT"

# -------------------------------------------------------------------- ready
cat <<BANNER

  ────────────────────────────────────────────────────────────
   MindForge is up

     app        http://localhost:$FRONTEND_PORT
     api        http://localhost:$BACKEND_PORT/api/health
     contract   $ADDRESS  (chain $CHAIN_ID)
     logs       logs/{chain,backend,frontend,deploy,issuer}.log

   The chain was redeployed, so it holds NO documents. Any record
   left in Mongo from an earlier run points at an anchor that no
   longer exists - issue your demo documents fresh now.

   Ctrl+C stops everything.
  ────────────────────────────────────────────────────────────

BANNER

wait
