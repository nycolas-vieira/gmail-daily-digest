package config

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
)

// builtinHard are senders confirmed 100% junk, kept in source (non-secret)
// so any clone gets the same baseline. Matched as substrings against the
// lowercased From header. Ported from Code.gs HARD_TRASH_SENDERS.
//
//	aliexpress  -> pure marketing
//	github.com  -> every github notification (notifications@/noreply@) is
//	               trash in this inbox; skipping the LLM here is free money.
var builtinHard = []string{"aliexpress", "github.com"}

// Blocklist is the two-tier sender filter:
//
//	Hard -> auto-trash, no LLM call, no review.
//	Soft -> skip LLM, apply label "Revisar" for manual triage.
//
// Auto-learn appends LLM-decided LIXO senders to Soft (not Hard) so the
// next email from them is reviewed, not silently dropped. The file lives
// outside the repo (git-ignored path) because it holds personal sender
// addresses.
type Blocklist struct {
	Hard []string `json:"hard"`
	Soft []string `json:"soft"`

	path string
}

// LoadBlocklist reads the blocklist file and merges the built-in hard
// defaults. A missing file is not fatal: it starts empty (built-ins only)
// and is created on first save.
func LoadBlocklist(path string) (*Blocklist, error) {
	bl := &Blocklist{path: path}
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			bl.Hard = append([]string{}, builtinHard...)
			return bl, nil
		}
		return nil, fmt.Errorf("read blocklist %s: %w", path, err)
	}
	if err := json.Unmarshal(raw, bl); err != nil {
		return nil, fmt.Errorf("parse blocklist %s: %w", path, err)
	}
	bl.path = path
	bl.mergeBuiltins()
	bl.normalize()
	return bl, nil
}

func (b *Blocklist) mergeBuiltins() {
	have := make(map[string]bool, len(b.Hard))
	for _, h := range b.Hard {
		have[strings.ToLower(strings.TrimSpace(h))] = true
	}
	for _, h := range builtinHard {
		if !have[h] {
			b.Hard = append(b.Hard, h)
		}
	}
}

func (b *Blocklist) normalize() {
	b.Hard = cleanList(b.Hard)
	b.Soft = cleanList(b.Soft)
}

func cleanList(in []string) []string {
	out := in[:0]
	for _, s := range in {
		s = strings.ToLower(strings.TrimSpace(s))
		if s != "" {
			out = append(out, s)
		}
	}
	return out
}

// Counts returns the number of hard and soft senders currently loaded
// (built-ins included), for the report's "current list sizes" section.
func (b *Blocklist) Counts() (hard, soft int) {
	return len(b.Hard), len(b.Soft)
}

// IsHard reports whether fromLower (a lowercased From header) matches any
// hard sender substring.
func (b *Blocklist) IsHard(fromLower string) bool {
	return matchAny(fromLower, b.Hard)
}

// IsSoft reports whether fromLower matches any soft sender substring.
func (b *Blocklist) IsSoft(fromLower string) bool {
	return matchAny(fromLower, b.Soft)
}

func matchAny(fromLower string, needles []string) bool {
	if fromLower == "" {
		return false
	}
	for _, n := range needles {
		if n != "" && strings.Contains(fromLower, n) {
			return true
		}
	}
	return false
}

// LearnSoft extracts the bare address from a "Name <addr>" header and
// appends it to Soft if not already covered by either tier. Returns the
// learned address (for stats) or "" if it was already known. Persists the
// file on a successful add.
func (b *Blocklist) LearnSoft(fromHeader string) (string, error) {
	addr := extractAddr(fromHeader)
	if addr == "" || !strings.Contains(addr, "@") {
		return "", nil
	}
	if matchAny(addr, b.Hard) || matchAny(addr, b.Soft) {
		return "", nil
	}
	b.Soft = append(b.Soft, addr)
	if err := b.Save(); err != nil {
		return "", err
	}
	return addr, nil
}

// PreviewLearnSoft returns the address LearnSoft would add for this header
// (or "" if already known/invalid) WITHOUT mutating or persisting anything.
// Used by the dry-run path so it can report what it would learn while
// honoring "persist nothing".
func (b *Blocklist) PreviewLearnSoft(fromHeader string) string {
	addr := extractAddr(fromHeader)
	if addr == "" || !strings.Contains(addr, "@") {
		return ""
	}
	if matchAny(addr, b.Hard) || matchAny(addr, b.Soft) {
		return ""
	}
	return addr
}

// Save writes the current lists back to disk, dropping the built-in hard
// defaults so the file stays user-managed (built-ins are re-merged on load).
func (b *Blocklist) Save() error {
	if b.path == "" {
		return fmt.Errorf("blocklist path empty, cannot save")
	}
	out := Blocklist{Hard: subtractBuiltins(b.Hard), Soft: b.Soft}
	raw, err := json.MarshalIndent(out, "", "  ")
	if err != nil {
		return err
	}
	// Atomic write: a concurrent writer (the launchd organize run learning a
	// SOFT sender while a -promote edits the file) must never see a truncated
	// or half-written blocklist. Unique temp + rename gives each writer its own
	// scratch file and an all-or-nothing publish.
	return writeFileAtomic(b.path, raw, 0o600)
}

func subtractBuiltins(hard []string) []string {
	builtin := make(map[string]bool, len(builtinHard))
	for _, h := range builtinHard {
		builtin[h] = true
	}
	var out []string
	for _, h := range hard {
		if !builtin[h] {
			out = append(out, h)
		}
	}
	if out == nil {
		out = []string{}
	}
	return out
}

func extractAddr(fromHeader string) string {
	low := strings.ToLower(strings.TrimSpace(fromHeader))
	if i := strings.IndexByte(low, '<'); i >= 0 {
		if j := strings.IndexByte(low[i:], '>'); j > 0 {
			return strings.TrimSpace(low[i+1 : i+j])
		}
	}
	return low
}
