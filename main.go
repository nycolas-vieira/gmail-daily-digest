// gmail-daily-digest V3: a local Go binary that organizes one or more
// Gmail inboxes with a local Ollama model. It replaces the Apps Script
// runtime (Code.gs + Gemini); see docs/CHANGELOG.md for the migration.
//
// Modes (mutually exclusive, default is organize):
//
//	gmail-daily-digest                 organize every account, accumulate state
//	gmail-daily-digest -dry-run        same, but take no action and persist nothing
//	gmail-daily-digest -report         render the period digest to report_dir, then reset
//	gmail-daily-digest -reset          clear counters and start a fresh period
//
// The repo is public: no secret is read from source. Everything sensitive
// (OAuth client, refresh tokens, learned senders) lives in the git-ignored
// config.json + state.json + blocklist produced by scripts/bootstrap-config.sh.
package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"time"

	"github.com/nycolas-vieira/gmail-daily-digest/internal/classify"
	"github.com/nycolas-vieira/gmail-daily-digest/internal/config"
	"github.com/nycolas-vieira/gmail-daily-digest/internal/organizer"
	"github.com/nycolas-vieira/gmail-daily-digest/internal/report"
)

func main() {
	var (
		configPath = flag.String("config", "config.json", "path to config.json")
		dryRun     = flag.Bool("dry-run", false, "classify and log actions but change nothing and persist nothing")
		doReport   = flag.Bool("report", false, "render the period digest to report_dir and reset counters")
		doReset    = flag.Bool("reset", false, "clear counters and start a fresh period")
	)
	flag.Parse()

	log.SetFlags(log.Ltime)

	if err := run(*configPath, *dryRun, *doReport, *doReset); err != nil {
		log.Fatalf("FATAL: %v", err)
	}
}

func run(configPath string, dryRun, doReport, doReset bool) error {
	cfg, err := config.Load(configPath)
	if err != nil {
		return err
	}

	now := time.Now()
	st, err := report.LoadState(cfg.StatePath, now)
	if err != nil {
		return err
	}

	switch {
	case doReset:
		if err := st.Reset(now); err != nil {
			return err
		}
		fmt.Println("state reset; new period starts", now.Format("2006-01-02 15:04"))
		return nil

	case doReport:
		return generateReport(cfg, st, now)

	default:
		return organize(cfg, st, dryRun)
	}
}

func organize(cfg *config.Config, st *report.State, dryRun bool) error {
	bl, err := config.LoadBlocklist(cfg.BlocklistPath)
	if err != nil {
		return err
	}

	cls := classify.New(cfg.Ollama.Endpoint, cfg.Ollama.Model, cfg.MaxBodyChars)
	ctx := context.Background()
	if err := cls.Ping(ctx); err != nil {
		return err
	}

	if dryRun {
		log.Printf("DRY-RUN: no Gmail action taken, no state/blocklist written")
	}

	org := organizer.New(cfg, bl, st, cls, dryRun)
	org.Run(ctx)

	if dryRun {
		log.Printf("DRY-RUN complete (state not saved)")
		return nil
	}
	if err := st.Save(); err != nil {
		return err
	}
	log.Printf("done: trashed=%d labeled=%d (state %s)", st.TrashedTotal, st.LabeledTotal, cfg.StatePath)
	return nil
}

func generateReport(cfg *config.Config, st *report.State, now time.Time) error {
	bl, err := config.LoadBlocklist(cfg.BlocklistPath)
	if err != nil {
		return err
	}
	hard, soft := bl.Counts()

	opts := report.RenderOpts{
		Now:           now,
		RevisarLabel:  organizer.RevisarLabel,
		HardListCount: hard,
		SoftListCount: soft,
	}
	path, err := st.SaveReport(cfg.ReportDir, opts)
	if err != nil {
		return err
	}
	fmt.Println("report saved:", path)

	if err := st.Reset(now); err != nil {
		return fmt.Errorf("report saved but reset failed: %w", err)
	}
	return nil
}
