#!/usr/bin/env bash
#
# run-organizer.sh - launchd-facing wrapper around the V3 organizer.
#
# WHY THIS EXISTS:
#   launchd fires StartCalendarInterval jobs the moment the Mac wakes from
#   sleep (and replays one missed calendar slot), but at that instant the
#   network is usually NOT up yet: DNS fails, the OAuth refresh 500s, and the
#   run dies. This wrapper blocks until the network can actually resolve
#   Google's OAuth host before invoking the container, so a wake-triggered
#   run does not crash on a cold network.
#
# WHAT IT DOES:
#   1. Verifies Docker is running (else logs and exits non-zero).
#   2. Waits for DNS/network to be ready (bounded retry).
#   3. cd to the repo and runs the organizer one-shot via docker compose.
#   4. Appends everything to the shared log with timestamps.
#
# OLLAMA ENDPOINT:
#   docker-compose.yml pins OLLAMA_ENDPOINT=http://ollama:11434 (the compose
#   ollama service, which has NO models pulled). We override it here to the
#   HOST's Ollama via host.docker.internal so the container reuses the models
#   already pulled on the Mac (gemma3:4b / gemma3:12b). The Go code lets an
#   OLLAMA_ENDPOINT env var win over config.json (internal/config/config.go),
#   so NO change to config.json is needed.
#
# USAGE:
#   scripts/run-organizer.sh            # organize (default)
#   scripts/run-organizer.sh -report    # render digest + reset counters
#   (any extra args are passed through to the organizer binary)
#
set -uo pipefail

# --- absolute paths (launchd has a minimal environment) ----------------------
REPO_DIR="/Users/nycolasvieira/repos/gmail-daily-digest"
LOG_FILE="/Users/nycolasvieira/.local/logs/gmail-daily-digest.log"

# Docker Desktop on macOS installs the CLI here; launchd's PATH does not
# include it by default, so make sure it is reachable.
export PATH="/usr/local/bin:/opt/homebrew/bin:/Applications/Docker.app/Contents/Resources/bin:$PATH"

# Reuse the host's Ollama (already has the models) instead of the empty
# compose ollama service. host.docker.internal resolves to the host on
# Docker Desktop for Mac.
export OLLAMA_ENDPOINT="http://host.docker.internal:11434"

# Network-readiness probe: this host must be resolvable+reachable before the
# organizer tries to refresh the OAuth token.
PROBE_URL="https://oauth2.googleapis.com"
MAX_TRIES=10
SLEEP_SECS=6

# --- logging helper ----------------------------------------------------------
mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '%s [run-organizer] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >>"$LOG_FILE"
}

log "=== invoked: args=[$*] ==="

# --- 1. Docker must be running -----------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "ERROR: docker CLI not found on PATH. Aborting."
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  log "ERROR: Docker daemon is not running (docker info failed). Aborting."
  exit 1
fi

# --- 2. wait for network/DNS to be ready -------------------------------------
ready=0
i=1
while [ "$i" -le "$MAX_TRIES" ]; do
  # Prefer curl (also proves TLS reachability); fall back to nslookup.
  if curl -sS -o /dev/null --max-time 5 "$PROBE_URL" 2>/dev/null \
     || nslookup oauth2.googleapis.com >/dev/null 2>&1; then
    ready=1
    log "network ready (attempt $i/$MAX_TRIES)"
    break
  fi
  log "network not ready yet (attempt $i/$MAX_TRIES), retrying in ${SLEEP_SECS}s"
  sleep "$SLEEP_SECS"
  i=$((i + 1))
done

if [ "$ready" -ne 1 ]; then
  log "ERROR: network still unreachable after $MAX_TRIES attempts. Aborting."
  exit 1
fi

# --- 3. run the organizer one-shot via docker compose ------------------------
cd "$REPO_DIR" || {
  log "ERROR: cannot cd to $REPO_DIR. Aborting."
  exit 1
}

log "running: docker compose run --rm --no-deps organizer $*"

# --no-deps: we point at the HOST Ollama, so do NOT spin up the (empty)
#   compose ollama service that depends_on would otherwise start.
# UID/GID make the container write state/reports as the host user, not root.
#   bash sets $UID itself and marks it READONLY, so we cannot reassign it as a
#   command prefix (that prints "UID: readonly variable"). Export the value
#   bash already holds, and only compute GID. compose reads them from the env.
export GID="$(id -g)"
export UID
# 2>&1 folds container stderr into the same log stream.
docker compose run --rm --no-deps organizer "$@" >>"$LOG_FILE" 2>&1
rc=$?

log "=== finished: exit=$rc ==="
exit "$rc"
