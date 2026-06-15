package config

import (
	"os"
	"path/filepath"
	"testing"
)

func loadTempBlocklist(t *testing.T, hard, soft []string) *Blocklist {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "blocklist.json")
	bl := &Blocklist{Hard: hard, Soft: soft, path: path}
	if err := bl.Save(); err != nil {
		t.Fatalf("seed save: %v", err)
	}
	got, err := LoadBlocklist(path)
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	return got
}

func TestPromoteToHard_ExactMatchMoves(t *testing.T) {
	bl := loadTempBlocklist(t, nil, []string{"promo@y.com", "keep@z.com"})
	changed, err := bl.PromoteToHard("promo@y.com")
	if err != nil || !changed {
		t.Fatalf("PromoteToHard changed=%v err=%v", changed, err)
	}
	if bl.IsSoft("promo@y.com") {
		t.Error("still SOFT after promote")
	}
	if !bl.IsHard("promo@y.com") {
		t.Error("not HARD after promote")
	}
	if !bl.IsSoft("keep@z.com") {
		t.Error("unrelated SOFT entry was dropped")
	}
	// Persisted: the user-managed HARD entry survives a reload (builtins are
	// re-merged, the promoted addr is stored).
	reloaded, _ := LoadBlocklist(bl.path)
	if !reloaded.IsHard("promo@y.com") {
		t.Error("promotion not persisted")
	}
}

func TestPromoteToHard_CollapsesDomain(t *testing.T) {
	bl := loadTempBlocklist(t, nil, []string{
		"friendsuggestion@facebookmail.com",
		"notification@priority.facebookmail.com",
		"other@gmail.com",
	})
	changed, err := bl.PromoteToHard("facebookmail.com")
	if err != nil || !changed {
		t.Fatalf("changed=%v err=%v", changed, err)
	}
	if bl.IsSoft("anything@facebookmail.com") {
		t.Error("facebookmail.com entries should be gone from SOFT")
	}
	if !bl.IsHard("x@facebookmail.com") {
		t.Error("facebookmail.com should now be HARD (substring match)")
	}
	if !bl.IsSoft("other@gmail.com") {
		t.Error("unrelated entry dropped")
	}
}

func TestPromoteToHard_NoopWhenUnknown(t *testing.T) {
	bl := loadTempBlocklist(t, nil, []string{"a@b.com"})
	changed, err := bl.PromoteToHard("github.com") // already a builtin HARD
	if err != nil {
		t.Fatal(err)
	}
	if changed {
		t.Error("expected no change for already-HARD builtin not in SOFT")
	}
}

func TestPromoteToHard_EmptyIsNoop(t *testing.T) {
	bl := loadTempBlocklist(t, nil, []string{"a@b.com"})
	changed, _ := bl.PromoteToHard("   ")
	if changed {
		t.Error("empty addr should be a noop")
	}
}

func TestMain(m *testing.M) { os.Exit(m.Run()) }
