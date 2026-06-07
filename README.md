# Gmail Daily Digest

A local Go binary that organizes one or more Gmail inboxes: it trashes junk,
labels and archives the rest by category, and writes a periodic Markdown
digest. Classification runs **entirely on your machine** with a local
[Ollama](https://ollama.com) model (`qwen2.5:7b`) - no cloud LLM, no API key,
no per-email cost.

> **V3 (this version)** replaces the previous Google Apps Script + Gemini
> runtime. The whole pipeline now runs locally from a single Go binary. The
> old `Code.gs` lives on in git history (last at tag `v2.5.1`); see
> `docs/CHANGELOG.md` for the migration.

## How it works

For each configured account, on every run:

1. Exchange the stored **refresh token** for a fresh access token (Google OAuth).
2. List **fresh inbox mail** the organizer has not touched (every label it
   manages is excluded, so re-runs are idempotent).
3. Apply the two-tier **sender blocklist** before paying for any inference:
   - **HARD** -> straight to Trash, no LLM call (e.g. `aliexpress`, `github.com`).
   - **SOFT** -> skip the LLM, apply the `Revisar` label for manual triage.
4. Classify the remainder **one email at a time** with the local Ollama model
   into one category, using Ollama structured outputs to pin the JSON shape:
   - `LIXO` -> trashed (and the sender is auto-learned into SOFT for next time)
   - `CONTAS` -> label `Contas` + archive
   - `NEWSLETTER` -> label `Newsletter` + archive
   - `URGENTE` -> label `Urgentes` (stays in inbox, raises an alert)
   - `PESSOAL` -> label `Pessoais` (stays in inbox)
   - `DOCUMENTO` -> label `Documentos` + archive
   - `OUTROS` -> label `Outros` + archive
5. Accumulate counters in a local `state.json`. Running with `-report` renders
   the period digest to `report_dir` and resets the period.

Single-email classification (vs the 25-per-prompt batches the Gemini version
used) is the main quality lever for a small local model: a 7B model is far
more reliable reasoning about one message than tracking 25 ids in one response.

## Why local

- **Zero cost / zero quota.** No Gemini key, no per-call billing, no rate limits.
- **Privacy.** Email content never leaves the machine; only Gmail API calls go out.
- **Public repo, zero secrets.** Nothing sensitive lives in source. The runtime
  config (OAuth client + per-account refresh tokens + learned senders) lives in
  git-ignored files reconstructed locally by `scripts/bootstrap-config.sh`.

## Project structure

```
gmail-daily-digest/
├── main.go                       # entry point + run modes
├── internal/
│   ├── config/                   # config.json loader + two-tier blocklist
│   ├── gmail/                    # thin Gmail REST client + OAuth + HTML strip
│   ├── classify/                 # Ollama structured-output classifier + prompt
│   ├── organizer/                # per-account pipeline (port of processAccount_)
│   └── report/                   # period state (state.json) + Markdown digest
├── config.example.json           # template (the real config.json is git-ignored)
├── scripts/bootstrap-config.sh   # generate config.json from your gmail-cli install
└── docs/CHANGELOG.md
```

## Prerequisites

- [Go](https://go.dev) 1.26+
- [Ollama](https://ollama.com) running locally, with the model pulled:
  ```bash
  ollama pull qwen2.5:7b
  ```
- An existing authenticated [gmail-cli](https://github.com/your-repo/gmail-cli)
  install at `~/.config/gmail-cli` (OAuth client in `credentials.json`,
  per-account `token.pickle` files). This is where the bootstrap reads the
  OAuth client and refresh tokens from.

## Setup

### 1. Generate the local config

```bash
./scripts/bootstrap-config.sh
```

This reads the OAuth client from `~/.config/gmail-cli/credentials.json` and the
per-account refresh tokens from `~/.config/gmail-cli/accounts/*/token.pickle`,
fetches each account's email via the Gmail profile API, and writes a
`config.json` (chmod 600, git-ignored). Pass `--force` to overwrite an existing
one, `--model <name>` to use a different Ollama model.

Review the generated `config.json` - remove accounts you do not want organized,
fix any with a blank `email` (Workspace accounts can be restricted for the
OAuth app and will be skipped at runtime). See `config.example.json` for the
shape and the tunables (`max_emails_per_run`, `max_body_chars`, paths).

### 2. Dry-run

```bash
go run . -dry-run
```

Classifies and logs every action it *would* take, but changes nothing in Gmail
and persists nothing (no state, no blocklist writes).

### 3. Run for real

```bash
go run .            # organize all accounts, accumulate state
go run . -report    # render the period digest to report_dir, then reset
go run . -reset     # clear counters, start a fresh period
```

Build a binary if you prefer: `go build -o gmail-daily-digest .`

## Docker

A `docker-compose.yml` runs the whole thing self-contained: an `ollama`
service (its own model volume) plus the `organizer` as a one-shot batch job.
**No secret is baked into any image** - `config.json` is bind-mounted
read-only, and the only writable host paths are the blocklist file and the
data dir (state + reports). `credentials.json` and the token pickles are
**not** exposed to the container.

```bash
# 1. Start Ollama and pull the model (once)
docker compose up -d ollama
docker compose exec ollama ollama pull qwen2.5:7b

# 2. Generate config.json on the host as usual
./scripts/bootstrap-config.sh

# 3. Run (UID/GID make the container write files as you, not root)
UID=$(id -u) GID=$(id -g) docker compose run --rm organizer            # organize
UID=$(id -u) GID=$(id -g) docker compose run --rm organizer -dry-run   # dry-run
UID=$(id -u) GID=$(id -g) docker compose run --rm organizer -report    # digest + reset
```

The container sets `OLLAMA_ENDPOINT=http://ollama:11434`, so the same
`config.json` (which points Ollama at `localhost` for native runs) works
unchanged. Override the model path with the `GMAIL_CLI_DIR` / `DIGEST_DATA_DIR`
env vars if your config uses non-default paths.

## Scheduling

The binary is stateless between runs (state lives in `state.json`), so schedule
it however you like - e.g. a `cron` entry running the organizer hourly and the
report once a day:

```cron
0 * * * *  cd ~/repos/gmail-daily-digest && /usr/local/bin/ollama serve >/dev/null 2>&1; ./gmail-daily-digest
0 20 * * * cd ~/repos/gmail-daily-digest && ./gmail-daily-digest -report
```

(Ensure `ollama serve` is running; the organizer fails fast with a clear
message if Ollama or the model is unreachable.)

## The sender blocklist

The two-tier blocklist lives outside the repo at
`~/.config/gmail-cli/organizer-blocklist.json` (git-ignored, shared with the
gmail-cli seed):

- **HARD** - confirmed junk, auto-trashed with no LLM call. A small built-in
  baseline (`aliexpress`, `github.com`) is merged in from source; everything
  else is yours.
- **SOFT** - get the `Revisar` label for manual triage instead of the trash.
  The organizer **auto-learns** any LLM-decided `LIXO` sender into SOFT (not
  HARD), so the next email from them is reviewed rather than silently dropped.
  Promote a sender to HARD yourself once you trust it as pure junk.

Matching is a case-insensitive substring test against the `From` header.

## Customization

- **Model:** `ollama.model` in `config.json` (default `qwen2.5:7b`). Smaller
  models (e.g. `llama3.2:3b`) classify noticeably worse.
- **Categories / labels / archive behavior:** `internal/organizer/organizer.go`
  (`labelNames`, `archiveCategories`).
- **Classification prompt:** `systemPrompt` in `internal/classify/classify.go`.
- **Batch size & body truncation:** `max_emails_per_run`, `max_body_chars`.
