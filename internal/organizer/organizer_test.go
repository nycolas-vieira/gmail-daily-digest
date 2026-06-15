package organizer

import (
	"testing"

	"github.com/nycolas-vieira/gmail-daily-digest/internal/config"
)

func TestIsOwn(t *testing.T) {
	cfg := &config.Config{Accounts: []config.Account{
		{Name: "personal", Email: "nycolas.nv@gmail.com"},
		{Name: "moonxi", Email: "nycolas@moonxi.com.br"},
	}}
	o := New(cfg, nil, nil, nil, false)

	cases := map[string]bool{
		"nycolas.nv@gmail.com":    true,
		"NYCOLAS.NV@GMAIL.COM":    true, // case-insensitive
		"  nycolas@moonxi.com.br": true, // trimmed
		"someone@else.com":        false,
		"":                        false,
	}
	for addr, want := range cases {
		if got := o.isOwn(addr); got != want {
			t.Errorf("isOwn(%q) = %v, want %v", addr, got, want)
		}
	}
}

func TestExtractAddr(t *testing.T) {
	cases := map[string]string{
		`"Gmail Organizer" <nycolas.nv@gmail.com>`: "nycolas.nv@gmail.com",
		"plain@addr.com":       "plain@addr.com",
		"  Spaced <x@y.com>  ": "x@y.com",
	}
	for in, want := range cases {
		if got := extractAddr(in); got != want {
			t.Errorf("extractAddr(%q) = %q, want %q", in, got, want)
		}
	}
}
