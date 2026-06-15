package deliver

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

type fakeSender struct {
	from, to, subject, body string
	err                     error
	called                  bool
}

func (f *fakeSender) Send(from, to, subject, htmlBody string) error {
	f.called = true
	f.from, f.to, f.subject, f.body = from, to, subject, htmlBody
	return f.err
}

func sampleSummary() Summary {
	start := time.Date(2026, 6, 15, 7, 40, 0, 0, time.UTC)
	return Summary{
		PeriodStart:    start,
		PeriodEnd:      start.Add(12 * time.Hour),
		TrashedTotal:   5,
		TrashedHard:    2,
		LabeledTotal:   8,
		RevisarCount:   3,
		RevisarSenders: []string{"spam@x.com", "spam@x.com", "promo@y.com", ""},
		SoftListTotal:  79,
		HardListTotal:  3,
		Alerts:         []string{"Conta 99Pay vence em 2026-06-17"},
	}
}

func TestEmail_RendersAndSends(t *testing.T) {
	fs := &fakeSender{}
	if err := Email(fs, "me@gmail.com", "me@gmail.com", sampleSummary()); err != nil {
		t.Fatalf("Email: %v", err)
	}
	if !fs.called {
		t.Fatal("Send was not called")
	}
	// Promotion candidates must be deduped and the empty one dropped.
	if strings.Count(fs.body, "spam@x.com") != 1 {
		t.Errorf("expected spam@x.com once, body=%s", fs.body)
	}
	if !strings.Contains(fs.body, "promo@y.com") {
		t.Errorf("missing promo@y.com candidate")
	}
	// The hint is HTML-escaped in the email (<addr> -> &lt;addr&gt;); assert
	// on the stable, escape-free prefix.
	if !strings.Contains(fs.body, "gmail-daily-digest -promote") {
		t.Errorf("missing promote hint, body=%s", fs.body)
	}
	if !strings.Contains(fs.subject, "Gmail Organizer") {
		t.Errorf("unexpected subject %q", fs.subject)
	}
}

func TestEchoPush_PostsDedupedPayload(t *testing.T) {
	var gotPath string
	var body map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath = r.URL.Path
		raw, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(raw, &body)
		w.WriteHeader(http.StatusOK)
	}))
	defer srv.Close()

	if err := EchoPush(srv.URL+"/gmail-organizer", "s3cr3t", sampleSummary()); err != nil {
		t.Fatalf("EchoPush: %v", err)
	}
	if gotPath != "/gmail-organizer/s3cr3t" {
		t.Errorf("path = %q, want /gmail-organizer/s3cr3t", gotPath)
	}
	senders, ok := body["revisar_senders"].([]any)
	if !ok || len(senders) != 2 {
		t.Errorf("revisar_senders = %v, want 2 deduped entries", body["revisar_senders"])
	}
	if body["promote_hint"] != promoteHint {
		t.Errorf("promote_hint = %v", body["promote_hint"])
	}
}

func TestEchoPush_Non2xxIsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusForbidden)
	}))
	defer srv.Close()
	if err := EchoPush(srv.URL, "wrong", sampleSummary()); err == nil {
		t.Fatal("expected error on 403")
	}
}
