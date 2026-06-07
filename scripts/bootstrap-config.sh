#!/usr/bin/env bash
#
# bootstrap-config.sh - generate the git-ignored config.json for V3.
#
# This repo is PUBLIC and ships zero secrets. The runtime config (OAuth
# client + per-account refresh tokens) is reconstructed locally from the
# gmail-cli install you already authenticated:
#
#   OAuth client -> ~/.config/gmail-cli/credentials.json  (installed.*)
#   per-account  -> ~/.config/gmail-cli/accounts/<name>/token.pickle
#
# It does NOT overwrite an existing config.json unless you pass --force.
# Reading the pickles needs Python with the google-auth libs; the script
# reuses the gmail-cli venv for that.
#
# Usage:
#   scripts/bootstrap-config.sh [--force] [--model qwen2.5:7b]
#
set -euo pipefail

GMAIL_CLI_DIR="${GMAIL_CLI_DIR:-$HOME/.config/gmail-cli}"
CREDS="$GMAIL_CLI_DIR/credentials.json"
ACCOUNTS_DIR="$GMAIL_CLI_DIR/accounts"
VENV_PY="$GMAIL_CLI_DIR/venv/bin/python"
OUT="config.json"
MODEL="qwen2.5:7b"
FORCE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1; shift ;;
    --model) MODEL="$2"; shift 2 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

[ -f "$CREDS" ] || { echo "ERROR: $CREDS not found (run gmail-cli auth first)" >&2; exit 1; }
[ -d "$ACCOUNTS_DIR" ] || { echo "ERROR: $ACCOUNTS_DIR not found" >&2; exit 1; }
[ -x "$VENV_PY" ] || { echo "ERROR: $VENV_PY not found (gmail-cli venv missing)" >&2; exit 1; }
if [ -f "$OUT" ] && [ "$FORCE" -ne 1 ]; then
  echo "ERROR: $OUT already exists. Re-run with --force to overwrite." >&2
  exit 1
fi

echo "Reading OAuth client + account refresh tokens..." >&2

MODEL="$MODEL" CREDS="$CREDS" ACCOUNTS_DIR="$ACCOUNTS_DIR" "$VENV_PY" - <<'PY' > "$OUT"
import json, os, pickle, sys, urllib.request
from google.auth.transport.requests import Request

creds_path = os.environ["CREDS"]
accounts_dir = os.environ["ACCOUNTS_DIR"]
model = os.environ["MODEL"]

inst = json.load(open(creds_path))["installed"]
client_id, client_secret = inst["client_id"], inst["client_secret"]

def profile_email(token):
    req = urllib.request.Request(
        "https://gmail.googleapis.com/gmail/v1/users/me/profile",
        headers={"Authorization": "Bearer " + token},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.load(r).get("emailAddress", "")
    except Exception:
        return ""

accounts = []
for name in sorted(os.listdir(accounts_dir)):
    pk = os.path.join(accounts_dir, name, "token.pickle")
    if not os.path.exists(pk):
        continue
    creds = pickle.load(open(pk, "rb"))
    rt = getattr(creds, "refresh_token", None)
    if not rt:
        print(f"WARN: {name} has no refresh_token, skipping", file=sys.stderr)
        continue
    try:
        creds.refresh(Request())
    except Exception as e:
        print(f"WARN: {name} token refresh failed ({e}); email left blank", file=sys.stderr)
    email = profile_email(getattr(creds, "token", "")) if getattr(creds, "token", "") else ""
    accounts.append({"name": name, "email": email, "refresh_token": rt})
    print(f"  + {name} ({email or 'email unknown'})", file=sys.stderr)

if not accounts:
    print("ERROR: no accounts with refresh tokens found", file=sys.stderr)
    sys.exit(1)

cfg = {
    "oauth": {"client_id": client_id, "client_secret": client_secret},
    "accounts": accounts,
    "ollama": {"endpoint": "http://localhost:11434", "model": model},
    "blocklist_path": "~/.config/gmail-cli/organizer-blocklist.json",
    "state_path": "~/.config/gmail-daily-digest/state.json",
    "report_dir": "~/.config/gmail-daily-digest/reports",
    "max_emails_per_run": 80,
    "max_body_chars": 1200,
}
print(json.dumps(cfg, indent=2, ensure_ascii=False))
PY

chmod 600 "$OUT"
echo "Wrote $OUT (chmod 600). Review accounts, then run: go run . -dry-run" >&2
