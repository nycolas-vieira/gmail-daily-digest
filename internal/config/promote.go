package config

import "strings"

// PromoteToHard moves a sender from the SOFT tier to the HARD tier so its
// future mail is auto-trashed instead of labeled "Revisar". It is the
// manual decision the period report asks the user to make.
//
// addr is matched case-insensitively against the SOFT list: an exact match
// is removed, otherwise any SOFT entry containing addr (or contained by it)
// is removed so "promote facebookmail.com" collapses several learned
// addresses. The (normalized) addr is then added to HARD if not already a
// HARD substring match. Returns whether anything changed; persists on change.
func (b *Blocklist) PromoteToHard(addr string) (bool, error) {
	addr = strings.ToLower(strings.TrimSpace(addr))
	if addr == "" {
		return false, nil
	}

	var keptSoft []string
	removed := false
	for _, s := range b.Soft {
		if s == addr || strings.Contains(s, addr) || strings.Contains(addr, s) {
			removed = true
			continue
		}
		keptSoft = append(keptSoft, s)
	}
	b.Soft = keptSoft

	alreadyHard := matchAny(addr, b.Hard)
	if !alreadyHard {
		b.Hard = append(b.Hard, addr)
	}

	if !removed && alreadyHard {
		return false, nil // nothing to do
	}
	if err := b.Save(); err != nil {
		return false, err
	}
	return true, nil
}

// SoftSenders returns a copy of the current SOFT list (promotion candidates
// surfaced in the report).
func (b *Blocklist) SoftSenders() []string {
	out := make([]string, len(b.Soft))
	copy(out, b.Soft)
	return out
}
