// Package gmail is a thin client over the Gmail REST API plus the OAuth
// refresh-token exchange. It mirrors the subset of calls the organizer
// used in the Apps Script version: list, get (full), trash, modify
// (labels + archive) and label ensure/create.
package gmail

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

const (
	tokenURL = "https://oauth2.googleapis.com/token"
	apiBase  = "https://gmail.googleapis.com/gmail/v1/users/me"
)

// Client talks to one account's mailbox with a short-lived access token.
type Client struct {
	http        *http.Client
	accessToken string
}

// NewClient exchanges a refresh token for an access token and returns a
// ready client. Fails loudly on any OAuth error - a bad token must not be
// papered over.
func NewClient(clientID, clientSecret, refreshToken string) (*Client, error) {
	hc := &http.Client{Timeout: 60 * time.Second}
	form := url.Values{
		"client_id":     {clientID},
		"client_secret": {clientSecret},
		"refresh_token": {refreshToken},
		"grant_type":    {"refresh_token"},
	}
	resp, err := hc.PostForm(tokenURL, form)
	if err != nil {
		return nil, fmt.Errorf("oauth request: %w", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	var tok struct {
		AccessToken      string `json:"access_token"`
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}
	if err := json.Unmarshal(body, &tok); err != nil {
		return nil, fmt.Errorf("oauth parse: %w (body=%s)", err, truncate(string(body), 200))
	}
	if tok.Error != "" {
		return nil, fmt.Errorf("oauth: %s - %s", tok.Error, tok.ErrorDescription)
	}
	if tok.AccessToken == "" {
		return nil, fmt.Errorf("oauth: empty access_token")
	}
	return &Client{http: hc, accessToken: tok.AccessToken}, nil
}

// Header holds one MIME header.
type Header struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// Part is a node of the MIME tree.
type Part struct {
	MimeType string   `json:"mimeType"`
	Headers  []Header `json:"headers"`
	Body     struct {
		Data string `json:"data"`
	} `json:"body"`
	Parts []Part `json:"parts"`
}

// Message is the subset of a Gmail message the organizer needs.
type Message struct {
	ID           string   `json:"id"`
	InternalDate string   `json:"internalDate"`
	LabelIDs     []string `json:"labelIds"`
	Payload      Part     `json:"payload"`
}

// Header returns the named header value (case-insensitive), or "".
func (m *Message) Header(name string) string {
	name = strings.ToLower(name)
	for _, h := range m.Payload.Headers {
		if strings.ToLower(h.Name) == name {
			return h.Value
		}
	}
	return ""
}

// Date returns the message internalDate as a time, or zero on parse error.
func (m *Message) Date() time.Time {
	ms, err := strconv.ParseInt(m.InternalDate, 10, 64)
	if err != nil {
		return time.Time{}
	}
	return time.UnixMilli(ms)
}

// BodyText returns up to maxChars of the best-effort plain-text body
// (text/plain preferred, HTML stripped as fallback).
func (m *Message) BodyText(maxChars int) string {
	var plain, html strings.Builder
	var walk func(p *Part)
	walk = func(p *Part) {
		switch p.MimeType {
		case "text/plain":
			plain.Write(decodeB64(p.Body.Data))
		case "text/html":
			html.Write(decodeB64(p.Body.Data))
		}
		for i := range p.Parts {
			walk(&p.Parts[i])
		}
	}
	walk(&m.Payload)
	text := plain.String()
	if strings.TrimSpace(text) == "" {
		text = stripHTML(html.String())
	}
	text = strings.TrimSpace(text)
	if maxChars > 0 && len(text) > maxChars {
		text = text[:maxChars]
	}
	return text
}

// ListMessageIDs returns up to maxResults message IDs matching query.
func (c *Client) ListMessageIDs(query string, maxResults int) ([]string, error) {
	var ids []string
	pageToken := ""
	for {
		remaining := maxResults - len(ids)
		if remaining <= 0 {
			break
		}
		per := remaining
		if per > 100 {
			per = 100
		}
		u := fmt.Sprintf("%s/messages?q=%s&maxResults=%d", apiBase, url.QueryEscape(query), per)
		if pageToken != "" {
			u += "&pageToken=" + pageToken
		}
		var out struct {
			Messages []struct {
				ID string `json:"id"`
			} `json:"messages"`
			NextPageToken string    `json:"nextPageToken"`
			Error         *apiError `json:"error"`
		}
		if err := c.getJSON(u, &out); err != nil {
			return nil, err
		}
		if out.Error != nil {
			return nil, fmt.Errorf("list: %s", out.Error.Message)
		}
		for _, mm := range out.Messages {
			ids = append(ids, mm.ID)
		}
		pageToken = out.NextPageToken
		if pageToken == "" {
			break
		}
	}
	return ids, nil
}

// GetMessage fetches a full message. Returns nil (no error) when the
// message cannot be read, so a single bad id never aborts a run.
func (c *Client) GetMessage(id string) *Message {
	u := fmt.Sprintf("%s/messages/%s?format=full", apiBase, id)
	var m Message
	var probe struct {
		Error *apiError `json:"error"`
	}
	raw, err := c.getRaw(u)
	if err != nil {
		return nil
	}
	if json.Unmarshal(raw, &probe) == nil && probe.Error != nil {
		return nil
	}
	if json.Unmarshal(raw, &m) != nil {
		return nil
	}
	return &m
}

// Trash moves a message to the Trash (Gmail purges after 30 days).
func (c *Client) Trash(id string) error {
	u := fmt.Sprintf("%s/messages/%s/trash", apiBase, id)
	return c.post(u, nil)
}

// ApplyLabel adds labelID to a message; when archive is true it also
// removes INBOX so the message leaves the inbox but stays under its label.
func (c *Client) ApplyLabel(id, labelID string, archive bool) error {
	u := fmt.Sprintf("%s/messages/%s/modify", apiBase, id)
	body := map[string]any{"addLabelIds": []string{labelID}}
	if archive {
		body["removeLabelIds"] = []string{"INBOX"}
	}
	return c.post(u, body)
}

// EnsureLabels returns a name->id map for every name, creating any that do
// not yet exist on the account.
func (c *Client) EnsureLabels(names []string) (map[string]string, error) {
	u := apiBase + "/labels"
	var list struct {
		Labels []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"labels"`
		Error *apiError `json:"error"`
	}
	if err := c.getJSON(u, &list); err != nil {
		return nil, err
	}
	if list.Error != nil {
		return nil, fmt.Errorf("labels list: %s", list.Error.Message)
	}
	byName := map[string]string{}
	for _, l := range list.Labels {
		byName[l.Name] = l.ID
	}
	result := map[string]string{}
	for _, name := range names {
		if id, ok := byName[name]; ok {
			result[name] = id
			continue
		}
		var created struct {
			ID    string    `json:"id"`
			Error *apiError `json:"error"`
		}
		payload := map[string]any{"name": name, "labelListVisibility": "labelShow", "messageListVisibility": "show"}
		if err := c.postJSON(u, payload, &created); err != nil {
			return nil, err
		}
		if created.Error != nil {
			return nil, fmt.Errorf("create label %s: %s", name, created.Error.Message)
		}
		result[name] = created.ID
	}
	return result, nil
}

// --- low-level helpers ---

type apiError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (c *Client) getRaw(u string) ([]byte, error) {
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("Authorization", "Bearer "+c.accessToken)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return io.ReadAll(resp.Body)
}

func (c *Client) getJSON(u string, out any) error {
	raw, err := c.getRaw(u)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

func (c *Client) post(u string, body any) error {
	return c.postJSON(u, body, nil)
}

func (c *Client) postJSON(u string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = strings.NewReader(string(b))
	}
	req, _ := http.NewRequest(http.MethodPost, u, rdr)
	req.Header.Set("Authorization", "Bearer "+c.accessToken)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return fmt.Errorf("HTTP %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

func decodeB64(s string) []byte {
	if s == "" {
		return nil
	}
	b, err := base64.URLEncoding.DecodeString(s)
	if err != nil {
		b, err = base64.StdEncoding.DecodeString(s)
		if err != nil {
			return nil
		}
	}
	return b
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
