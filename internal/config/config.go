// Package config loads the local runtime configuration for the gmail
// organizer V3. The repo is PUBLIC, so nothing secret lives in source:
// the real config.json (OAuth client + per-account refresh tokens) is
// git-ignored and produced by scripts/bootstrap-config.sh. Missing or
// invalid values fail loudly - no fallbacks, no defaults that hide a
// broken setup (one source of truth).
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

type OAuth struct {
	ClientID     string `json:"client_id"`
	ClientSecret string `json:"client_secret"`
}

type Account struct {
	Name         string `json:"name"`
	Email        string `json:"email"`
	RefreshToken string `json:"refresh_token"`
}

type Ollama struct {
	Endpoint string `json:"endpoint"`
	Model    string `json:"model"`
}

// Report holds the optional delivery channels for the period digest. Every
// field is optional: an empty channel is simply skipped (the markdown file
// in report_dir is always written regardless). Secrets can be injected via
// env (REPORT_EMAIL / ARGUS_WEBHOOK_URL / ARGUS_WEBHOOK_SECRET) so the same
// config.json can run unchanged inside Docker.
type Report struct {
	// Email is the recipient of the digest mail. Empty -> no email sent.
	Email string `json:"email"`
	// FromAccount is the configured account NAME used to send the mail
	// (must exist in Accounts and carry the gmail.send scope). Empty
	// defaults to "personal".
	FromAccount string `json:"from_account"`
	// ArgusWebhookURL is the argus-webhook gmail endpoint base, e.g.
	// https://<run-url>/gmail (the secret is appended as the last path
	// segment). Empty -> no Echo/Telegram push.
	ArgusWebhookURL string `json:"argus_webhook_url"`
	// ArgusWebhookSecret is the URL-safe path secret for that endpoint.
	ArgusWebhookSecret string `json:"argus_webhook_secret"`
}

type Config struct {
	OAuth           OAuth     `json:"oauth"`
	Accounts        []Account `json:"accounts"`
	Ollama          Ollama    `json:"ollama"`
	Report          Report    `json:"report"`
	BlocklistPath   string    `json:"blocklist_path"`
	StatePath       string    `json:"state_path"`
	ReportDir       string    `json:"report_dir"`
	MaxEmailsPerRun int       `json:"max_emails_per_run"`
	MaxBodyChars    int       `json:"max_body_chars"`
}

// AccountByName returns the configured account with the given name, or nil.
func (c *Config) AccountByName(name string) *Account {
	for i := range c.Accounts {
		if c.Accounts[i].Name == name {
			return &c.Accounts[i]
		}
	}
	return nil
}

// Load reads and validates config.json. Every field that the rest of the
// program assumes present is checked here so failures surface at startup,
// not mid-run against a real inbox.
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config %s: %w (run scripts/bootstrap-config.sh first)", path, err)
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("parse config %s: %w", path, err)
	}

	c.BlocklistPath = expandHome(c.BlocklistPath)
	c.StatePath = expandHome(c.StatePath)
	c.ReportDir = expandHome(c.ReportDir)

	if c.MaxEmailsPerRun <= 0 {
		c.MaxEmailsPerRun = 80
	}
	if c.MaxBodyChars <= 0 {
		c.MaxBodyChars = 1200
	}
	if c.Ollama.Endpoint == "" {
		c.Ollama.Endpoint = "http://localhost:11434"
	}

	// Env overrides let the SAME config.json run unchanged inside Docker,
	// where Ollama lives at a different host (e.g. http://ollama:11434).
	if v := os.Getenv("OLLAMA_ENDPOINT"); v != "" {
		c.Ollama.Endpoint = v
	}
	if v := os.Getenv("OLLAMA_MODEL"); v != "" {
		c.Ollama.Model = v
	}

	// Report delivery secrets can come from env (preferred inside Docker).
	if v := os.Getenv("REPORT_EMAIL"); v != "" {
		c.Report.Email = v
	}
	if v := os.Getenv("ARGUS_WEBHOOK_URL"); v != "" {
		c.Report.ArgusWebhookURL = v
	}
	if v := os.Getenv("ARGUS_WEBHOOK_SECRET"); v != "" {
		c.Report.ArgusWebhookSecret = v
	}
	if c.Report.FromAccount == "" {
		c.Report.FromAccount = "personal"
	}

	if err := c.validate(); err != nil {
		return nil, err
	}
	return &c, nil
}

func (c *Config) validate() error {
	var missing []string
	if c.OAuth.ClientID == "" {
		missing = append(missing, "oauth.client_id")
	}
	if c.OAuth.ClientSecret == "" {
		missing = append(missing, "oauth.client_secret")
	}
	if c.Ollama.Model == "" {
		missing = append(missing, "ollama.model")
	}
	if c.StatePath == "" {
		missing = append(missing, "state_path")
	}
	if c.ReportDir == "" {
		missing = append(missing, "report_dir")
	}
	if len(c.Accounts) == 0 {
		missing = append(missing, "accounts (none configured)")
	}
	for i, a := range c.Accounts {
		if a.Name == "" || a.RefreshToken == "" {
			missing = append(missing, fmt.Sprintf("accounts[%d] (name+refresh_token required)", i))
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("config invalid, missing: %s", strings.Join(missing, ", "))
	}
	return nil
}

func expandHome(p string) string {
	if p == "" {
		return p
	}
	if p == "~" || strings.HasPrefix(p, "~/") {
		home, err := os.UserHomeDir()
		if err == nil {
			return filepath.Join(home, strings.TrimPrefix(p, "~"))
		}
	}
	return p
}
