// Package outlook is a thin Microsoft Graph client for the organizer, plus
// the OAuth plumbing for a personal Microsoft account (MSA). It mirrors the
// subset of calls internal/gmail exposes so the organizer drives both behind
// the mailbox.Client interface.
//
// Auth model: a public-client Azure app (no secret). The digest owns its OWN
// refresh token, decoupled from mail-cli/outlook-sync, stored per account in a
// token file. MSA rotates the refresh token on every refresh, so we persist
// the new one each run.
package outlook

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const (
	authority = "https://login.microsoftonline.com/consumers/oauth2/v2.0"
	graphBase = "https://graph.microsoft.com/v1.0"
	// Mail.ReadWrite covers list/read + categorize + move (trash/archive).
	// MailboxSettings.ReadWrite is needed to create master categories (colors +
	// registration in the Outlook category picker).
	scopes = "Mail.ReadWrite MailboxSettings.ReadWrite offline_access"
)

// TokenPath returns the per-account refresh-token file path.
func TokenPath(dir, account string) string {
	return filepath.Join(dir, "outlook-token-"+account+".json")
}

type tokenStore struct {
	RefreshToken string `json:"refresh_token"`
}

func loadRT(path string) (string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read outlook token %s: %w (run with -outlook-auth <account>)", path, err)
	}
	var ts tokenStore
	if err := json.Unmarshal(raw, &ts); err != nil {
		return "", fmt.Errorf("parse outlook token %s: %w", path, err)
	}
	if ts.RefreshToken == "" {
		return "", fmt.Errorf("outlook token %s has empty refresh_token", path)
	}
	return ts.RefreshToken, nil
}

func saveRT(path, rt string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	data, _ := json.MarshalIndent(tokenStore{RefreshToken: rt}, "", "  ")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

type tokenResp struct {
	AccessToken      string `json:"access_token"`
	RefreshToken     string `json:"refresh_token"`
	Error            string `json:"error"`
	ErrorDescription string `json:"error_description"`
}

// refreshToken exchanges a refresh token for an access token. MSA may rotate
// the refresh token, so the (possibly new) one is returned to be persisted.
func refreshToken(hc *http.Client, clientID, rt string) (access, newRT string, err error) {
	form := url.Values{
		"client_id":     {clientID},
		"grant_type":    {"refresh_token"},
		"refresh_token": {rt},
		"scope":         {scopes},
	}
	resp, err := hc.PostForm(authority+"/token", form)
	if err != nil {
		return "", "", fmt.Errorf("oauth request: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var tok tokenResp
	if err := json.Unmarshal(body, &tok); err != nil {
		return "", "", fmt.Errorf("oauth parse: %w (body=%s)", err, truncate(string(body), 200))
	}
	if tok.Error != "" {
		return "", "", fmt.Errorf("oauth: %s - %s", tok.Error, tok.ErrorDescription)
	}
	if tok.AccessToken == "" {
		return "", "", fmt.Errorf("oauth: empty access_token")
	}
	if tok.RefreshToken == "" {
		tok.RefreshToken = rt // no rotation this time; keep the current one
	}
	return tok.AccessToken, tok.RefreshToken, nil
}

// DeviceCode runs the device-code flow and writes the resulting refresh token
// to tokenPath. Interactive: it prints the verification URL + code and blocks
// until the user authenticates (or the code expires).
func DeviceCode(clientID, tokenPath string) error {
	hc := &http.Client{Timeout: 60 * time.Second}

	dcResp, err := hc.PostForm(authority+"/devicecode", url.Values{
		"client_id": {clientID},
		"scope":     {scopes},
	})
	if err != nil {
		return fmt.Errorf("devicecode request: %w", err)
	}
	body, _ := io.ReadAll(dcResp.Body)
	dcResp.Body.Close()
	var dc struct {
		DeviceCode      string `json:"device_code"`
		UserCode        string `json:"user_code"`
		VerificationURI string `json:"verification_uri"`
		Interval        int    `json:"interval"`
		Message         string `json:"message"`
		Error           string `json:"error"`
		ErrorDesc       string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &dc); err != nil {
		return fmt.Errorf("devicecode parse: %w (body=%s)", err, truncate(string(body), 200))
	}
	if dc.Error != "" {
		return fmt.Errorf("devicecode: %s - %s", dc.Error, dc.ErrorDesc)
	}
	if dc.Message != "" {
		fmt.Println("\n" + dc.Message + "\n")
	} else {
		fmt.Printf("\nOpen %s and enter code %s\n\n", dc.VerificationURI, dc.UserCode)
	}

	interval := dc.Interval
	if interval <= 0 {
		interval = 5
	}
	for {
		time.Sleep(time.Duration(interval) * time.Second)
		resp, err := hc.PostForm(authority+"/token", url.Values{
			"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
			"client_id":   {clientID},
			"device_code": {dc.DeviceCode},
		})
		if err != nil {
			return fmt.Errorf("token poll: %w", err)
		}
		b, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		var tok tokenResp
		if err := json.Unmarshal(b, &tok); err != nil {
			return fmt.Errorf("token poll parse: %w", err)
		}
		switch tok.Error {
		case "":
			if tok.RefreshToken == "" {
				return fmt.Errorf("device flow: empty refresh_token")
			}
			if err := saveRT(tokenPath, tok.RefreshToken); err != nil {
				return err
			}
			fmt.Printf("✅ Outlook autenticado, refresh token salvo em %s\n", tokenPath)
			return nil
		case "authorization_pending":
			continue
		case "slow_down":
			interval += 5
		default:
			return fmt.Errorf("device flow: %s - %s", tok.Error, tok.ErrorDescription)
		}
	}
}

func truncate(s string, n int) string {
	s = strings.ReplaceAll(s, "\n", " ")
	if len(s) > n {
		return s[:n]
	}
	return s
}
