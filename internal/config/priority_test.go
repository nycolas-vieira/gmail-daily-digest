package config

import (
	"path/filepath"
	"testing"
)

// TestPriorityMatchAndPersist covers the priority tier: substring matching
// against a From header, and that Save round-trips the list (it used to be
// dropped by Save, which would silently lose priority senders).
func TestPriorityMatchAndPersist(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "blocklist.json")
	bl := &Blocklist{Priority: []string{"vip@example.com"}, path: path}
	if err := bl.Save(); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := LoadBlocklist(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}

	if len(got.Priority) != 1 || got.Priority[0] != "vip@example.com" {
		t.Fatalf("priority not persisted: %v", got.Priority)
	}
	// Real From headers carry a display name + angle brackets.
	if !got.IsPriority(`vip person <vip@example.com>`) {
		t.Error("expected priority match on full From header")
	}
	if got.IsPriority(`someone <other@example.com>`) {
		t.Error("unexpected priority match on unrelated sender")
	}
}

// TestPriorityIndependentOfTiers makes sure the tiers do not bleed into each
// other (a priority sender is not reported as Hard/Soft just by being priority).
func TestPriorityIndependentOfTiers(t *testing.T) {
	bl := &Blocklist{Priority: []string{"vip@x.com"}, Hard: []string{"junk@y.com"}}
	bl.normalize()
	from := "vip <vip@x.com>"
	if !bl.IsPriority(from) {
		t.Error("priority sender should match IsPriority")
	}
	if bl.IsHard(from) || bl.IsSoft(from) {
		t.Error("priority sender must not match Hard/Soft")
	}
}
