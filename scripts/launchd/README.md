# launchd scheduling for gmail-daily-digest V3

This replaces the old `cron` schedule with `launchd`. The reason is the
sleep gap: macOS `cron` does NOT fire while the Mac is asleep and never
replays a missed job, which is why the 2026-06-15 07h report was lost.
`launchd` with `StartCalendarInterval` runs a missed calendar slot ONCE
after the Mac wakes, closing that gap.

The organizer itself now runs inside Docker (`docker compose run --rm
--no-deps organizer`), driven by the `scripts/run-organizer.sh` wrapper,
which waits for the network to come up before invoking the container.

## Files

| File | Purpose | Schedule |
|------|---------|----------|
| `com.nyc.gmail-digest.organize.plist` | organize pass | 07:00 and 19:00 local |
| `com.nyc.gmail-digest.report.plist` | digest + counter reset | 07:30 and 19:30 local |

Both point at `/Users/nycolasvieira/repos/gmail-daily-digest/scripts/run-organizer.sh`
and log to `/Users/nycolasvieira/.local/logs/gmail-daily-digest.log`.

## Ollama endpoint (important, no config.json edit needed)

`docker-compose.yml` pins `OLLAMA_ENDPOINT=http://ollama:11434` (the compose
`ollama` service). That service has NO models pulled (it would need an ~8 GB
pull). The host already runs Ollama on `localhost:11434` with `gemma3:4b` and
`gemma3:12b` pulled.

So the wrapper exports `OLLAMA_ENDPOINT=http://host.docker.internal:11434`,
which points the container at the HOST's Ollama and reuses the already-pulled
models. The Go code lets the `OLLAMA_ENDPOINT` env var win over `config.json`
(`internal/config/config.go`), so:

- You do NOT need to edit `config.json`.
- You do NOT need to start the compose `ollama` service (the wrapper uses
  `--no-deps` so `docker compose` will not spin it up).

The only requirement is that the host's Ollama is serving on `:11434` (it
already is). If you ever stop the host Ollama, the container runs will fail
the model Ping and exit non-zero (logged), which is the intended fail-loud
behavior.

## Install

```bash
# 1. Make sure the wrapper is executable (it ships +x, this is a safety net).
chmod +x /Users/nycolasvieira/repos/gmail-daily-digest/scripts/run-organizer.sh

# 2. Copy the plists into your user LaunchAgents dir.
cp /Users/nycolasvieira/repos/gmail-daily-digest/scripts/launchd/com.nyc.gmail-digest.organize.plist \
   ~/Library/LaunchAgents/
cp /Users/nycolasvieira/repos/gmail-daily-digest/scripts/launchd/com.nyc.gmail-digest.report.plist \
   ~/Library/LaunchAgents/

# 3. Load them (the -w flag marks them enabled persistently).
launchctl load -w ~/Library/LaunchAgents/com.nyc.gmail-digest.organize.plist
launchctl load -w ~/Library/LaunchAgents/com.nyc.gmail-digest.report.plist

# 4. Confirm they are registered.
launchctl list | grep gmail-digest
```

## Test a run on demand

`kickstart -k` force-runs the job right now (the `-k` kills any running copy
first), independent of the calendar slot:

```bash
# Run the hourly organize pass now.
launchctl kickstart -k gui/$(id -u)/com.nyc.gmail-digest.organize

# Run the report pass now.
launchctl kickstart -k gui/$(id -u)/com.nyc.gmail-digest.report

# Watch the log.
tail -f /Users/nycolasvieira/.local/logs/gmail-daily-digest.log
```

The first container run builds the `gmail-daily-digest:3.0.0` image, so it
will be slower; later runs reuse the image. Make sure Docker Desktop is
running (the wrapper aborts non-zero with a logged error if it is not).

## Uninstall

```bash
launchctl unload -w ~/Library/LaunchAgents/com.nyc.gmail-digest.organize.plist
launchctl unload -w ~/Library/LaunchAgents/com.nyc.gmail-digest.report.plist
rm ~/Library/LaunchAgents/com.nyc.gmail-digest.organize.plist
rm ~/Library/LaunchAgents/com.nyc.gmail-digest.report.plist
```

## Manual step: remove the old cron lines (do this AFTER launchd is verified)

The old schedule is still in your crontab and will double-run alongside
launchd until you remove it. Once you have confirmed a launchd run worked
(check the log), edit the crontab and delete the three lines under the
`=== gmail-daily-digest V3 ===` header:

```bash
crontab -e
```

Delete the header comment and these lines:

```
0 * * * *  /Users/nycolasvieira/bin/gmail-daily-digest -config /Users/nycolasvieira/repos/gmail-daily-digest/config.json >> /Users/nycolasvieira/.local/logs/gmail-daily-digest.log 2>&1
40 7,19 * * * /Users/nycolasvieira/bin/gmail-daily-digest -config ... -report >> ... 2>&1
```

(There are 3 lines counting the header comment.) Save and exit. Verify with
`crontab -l | grep gmail` returning nothing.
