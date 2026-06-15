// Package report owns the cross-run counters (period stats) and renders
// the Markdown digest. State is persisted to a local JSON file - the
// local-runtime replacement for the Apps Script ScriptProperties counters.
package report

import (
	"encoding/json"
	"fmt"
	"os"
	"time"
)

// State accumulates everything that happened since the last report. It is
// loaded at the start of a report run, rendered, then Reset.
type State struct {
	PeriodStart     time.Time      `json:"period_start"`
	TrashedTotal    int            `json:"trashed_total"`
	LabeledTotal    int            `json:"labeled_total"`
	LixoHard        int            `json:"lixo_hard"`
	PerAccount      map[string]int `json:"per_account"`       // trashed per account
	PerLabel        map[string]int `json:"per_label"`         // labeled per label name
	ErrorsByAccount map[string]int `json:"errors_by_account"` // run errors per account
	Alerts          []string       `json:"alerts"`
	SoftTrashAdded  []string       `json:"soft_trash_added"`
	HardTrashAdded  []string       `json:"hard_trash_added"`
	RevisarSenders  []string       `json:"revisar_senders"` // SOFT-matched senders seen this period

	path string
}

// LoadState reads the state file, initializing a fresh period if absent.
func LoadState(path string, now time.Time) (*State, error) {
	s := &State{path: path}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			s.init(now)
			return s, nil
		}
		return nil, fmt.Errorf("read state %s: %w", path, err)
	}
	if err := json.Unmarshal(raw, s); err != nil {
		return nil, fmt.Errorf("parse state %s: %w", path, err)
	}
	s.path = path
	s.ensureMaps()
	if s.PeriodStart.IsZero() {
		s.PeriodStart = now
	}
	return s, nil
}

func (s *State) init(now time.Time) {
	s.PeriodStart = now
	s.ensureMaps()
}

func (s *State) ensureMaps() {
	if s.PerAccount == nil {
		s.PerAccount = map[string]int{}
	}
	if s.PerLabel == nil {
		s.PerLabel = map[string]int{}
	}
	if s.ErrorsByAccount == nil {
		s.ErrorsByAccount = map[string]int{}
	}
}

// Save persists the state to disk.
func (s *State) Save() error {
	if s.path == "" {
		return fmt.Errorf("state path empty, cannot save")
	}
	raw, err := json.MarshalIndent(s, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(s.path, raw, 0o600)
}

// Reset clears the counters and starts a new period at now, then saves.
func (s *State) Reset(now time.Time) error {
	s.PeriodStart = now
	s.TrashedTotal = 0
	s.LabeledTotal = 0
	s.LixoHard = 0
	s.PerAccount = map[string]int{}
	s.PerLabel = map[string]int{}
	s.ErrorsByAccount = map[string]int{}
	s.Alerts = nil
	s.SoftTrashAdded = nil
	s.HardTrashAdded = nil
	s.RevisarSenders = nil
	return s.Save()
}

// --- mutation helpers used by the organizer ---

func (s *State) AddTrashed(account string, hard bool) {
	s.ensureMaps()
	s.TrashedTotal++
	s.PerAccount[account]++
	if hard {
		s.LixoHard++
	}
}

func (s *State) AddLabeled(label string) {
	s.ensureMaps()
	s.LabeledTotal++
	s.PerLabel[label]++
}

func (s *State) AddError(account string) {
	s.ensureMaps()
	s.ErrorsByAccount[account]++
}

func (s *State) AddAlert(a string) {
	s.Alerts = append(s.Alerts, a)
	if len(s.Alerts) > 100 {
		s.Alerts = s.Alerts[len(s.Alerts)-100:]
	}
}

func (s *State) AddSoftLearned(addr string)  { s.SoftTrashAdded = append(s.SoftTrashAdded, addr) }
func (s *State) AddHardPromoted(addr string) { s.HardTrashAdded = append(s.HardTrashAdded, addr) }

// AddRevisarSender records a SOFT-matched sender that got the "Revisar"
// label this period. The deduped list feeds the report's promote-to-HARD
// suggestion. addr is the bare sender address.
func (s *State) AddRevisarSender(addr string) {
	if addr != "" {
		s.RevisarSenders = append(s.RevisarSenders, addr)
	}
}
