package report

import (
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// RenderOpts carries the bits the renderer needs beyond the State itself.
type RenderOpts struct {
	Now           time.Time
	RevisarLabel  string // label name used for the SOFT route
	HardListCount int
	SoftListCount int
}

// Markdown renders the period digest. Mirrors the Apps Script report:
// split trashed by source (silent HARD vs LLM LIXO), call out the SOFT
// route, audit the learned/promoted senders and current list sizes.
func (s *State) Markdown(o RenderOpts) string {
	d := "2006-01-02"
	dt := "2006-01-02 15:04"
	var b strings.Builder
	w := func(format string, a ...any) { fmt.Fprintf(&b, format+"\n", a...) }

	w("---")
	w("summary: Gmail organizer report %s", o.Now.Format(dt))
	w("tags: [gmail, organizer, report]")
	w("created: %s", o.Now.Format(d))
	w("updated: %s", o.Now.Format(d))
	w("---")
	w("")
	w("# Gmail Organizer - %s", o.Now.Format(dt))
	w("")
	start := "(inicio)"
	if !s.PeriodStart.IsZero() {
		start = s.PeriodStart.Format(dt)
	}
	w("**Periodo:** %s -> %s", start, o.Now.Format(dt))
	w("")

	// Apagados - silent (HARD) vs LLM-decided (LIXO).
	w("## Apagados")
	if s.TrashedTotal == 0 {
		w("- (nenhum)")
	} else {
		parts := nonZeroParts(s.PerAccount)
		geminiLixo := s.TrashedTotal - s.LixoHard
		if geminiLixo < 0 {
			geminiLixo = 0
		}
		w("- **Total:** %d (%s)", s.TrashedTotal, orDefault(strings.Join(parts, ", "), "desconhecido"))
		w("  - HARD blocklist (silencioso, sem LLM): %d", s.LixoHard)
		w("  - LLM classificou LIXO: %d", geminiLixo)
	}
	w("")

	// Catalogados - SOFT route split out.
	w("## Catalogados")
	if s.LabeledTotal == 0 {
		w("- (nenhum)")
	} else {
		revisar := s.PerLabel[o.RevisarLabel]
		other := s.LabeledTotal - revisar
		var parts []string
		for _, k := range sortedKeys(s.PerLabel) {
			if k == o.RevisarLabel || s.PerLabel[k] == 0 {
				continue
			}
			parts = append(parts, fmt.Sprintf("%d %s", s.PerLabel[k], k))
		}
		w("- **Total:** %d", s.LabeledTotal)
		w("  - SOFT blocklist -> label `%s`: %d", o.RevisarLabel, revisar)
		w("  - Categorizados por LLM: %d (%s)", other, orDefault(strings.Join(parts, ", "), "nenhum"))
	}
	w("")

	w("## Adicionados ao HARD (auto-trash)")
	if hard := unique(s.HardTrashAdded); len(hard) == 0 {
		w("- (nenhum)")
	} else {
		for _, a := range hard {
			w("- %s", a)
		}
		w("")
		w("> Esses senders vao direto pro Trash, sem LLM, sem label.")
	}
	w("")

	w("## Adicionados ao SOFT (para revisao)")
	if soft := unique(s.SoftTrashAdded); len(soft) == 0 {
		w("- (nenhum)")
	} else {
		for _, a := range soft {
			w("- %s", a)
		}
		w("")
		w("> Recebem a label `%s` (nao vao pro trash). Reveja no Gmail; promova a HARD se forem lixo confirmado.", o.RevisarLabel)
	}
	w("")

	if rev := s.PerLabel[o.RevisarLabel]; rev > 0 {
		w("## Em revisao (label `%s`)", o.RevisarLabel)
		w("- **%d** email(s) marcados como %s no periodo.", rev, o.RevisarLabel)
		w("")
	}

	w("## Estado atual das listas")
	w("- **HARD:** %d sender(s) (auto-trash)", o.HardListCount)
	w("- **SOFT:** %d sender(s) (label %s)", o.SoftListCount, o.RevisarLabel)
	w("")

	w("## Alertas")
	if len(s.Alerts) == 0 {
		w("- (nenhum)")
	} else {
		for _, a := range s.Alerts {
			w("- %s", a)
		}
	}
	w("")

	if errs := nonZeroParts(s.ErrorsByAccount); len(errs) > 0 {
		w("## Erros")
		for _, k := range sortedKeys(s.ErrorsByAccount) {
			if s.ErrorsByAccount[k] > 0 {
				w("- %s: %d", k, s.ErrorsByAccount[k])
			}
		}
		w("")
	}

	return b.String()
}

// SaveReport writes the rendered markdown into reportDir as
// yyyy-MM-dd-HHh.md and returns the full path.
func (s *State) SaveReport(reportDir string, o RenderOpts) (string, error) {
	if err := os.MkdirAll(reportDir, 0o755); err != nil {
		return "", err
	}
	name := o.Now.Format("2006-01-02-15") + "h.md"
	path := filepath.Join(reportDir, name)
	if err := os.WriteFile(path, []byte(s.Markdown(o)), 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func nonZeroParts(m map[string]int) []string {
	var parts []string
	for _, k := range sortedKeys(m) {
		if m[k] > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", m[k], k))
		}
	}
	return parts
}

func sortedKeys(m map[string]int) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func unique(in []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
