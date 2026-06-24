package outlook

import (
	"encoding/json"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/nycolas-vieira/gmail-daily-digest/internal/mailbox"
)

// Client talks to one Outlook account over Microsoft Graph with a short-lived
// access token. It satisfies mailbox.Client.
type Client struct {
	http        *http.Client
	accessToken string
	managed     map[string]bool // categories we manage (idempotency)
}

// NewClient loads the account's refresh token, exchanges it for an access
// token (persisting the rotated refresh token), and returns a ready client.
func NewClient(clientID, tokenPath string) (*Client, error) {
	if clientID == "" {
		return nil, fmt.Errorf("outlook: empty client_id (set outlook_client_id in config)")
	}
	hc := &http.Client{Timeout: 60 * time.Second}
	rt, err := loadRT(tokenPath)
	if err != nil {
		return nil, err
	}
	access, newRT, err := refreshToken(hc, clientID, rt)
	if err != nil {
		return nil, err
	}
	if newRT != rt {
		if err := saveRT(tokenPath, newRT); err != nil {
			return nil, fmt.Errorf("persist rotated outlook token: %w", err)
		}
	}
	return &Client{http: hc, accessToken: access, managed: map[string]bool{}}, nil
}

// --- Message ---------------------------------------------------------------

type graphMessage struct {
	ID           string   `json:"id"`
	Subject      string   `json:"subject"`
	BodyPreview  string   `json:"bodyPreview"`
	ReceivedAt   string   `json:"receivedDateTime"`
	Categories   []string `json:"categories"`
	From         recip    `json:"from"`
	ToRecipients []recip  `json:"toRecipients"`
	CcRecipients []recip  `json:"ccRecipients"`
	Body         struct {
		ContentType string `json:"contentType"`
		Content     string `json:"content"`
	} `json:"body"`
	InternetMessageHeaders []struct {
		Name  string `json:"name"`
		Value string `json:"value"`
	} `json:"internetMessageHeaders"`
}

type recip struct {
	EmailAddress struct {
		Name    string `json:"name"`
		Address string `json:"address"`
	} `json:"emailAddress"`
}

func (r recip) header() string {
	a := r.EmailAddress
	if a.Name != "" && a.Address != "" {
		return fmt.Sprintf("%s <%s>", a.Name, a.Address)
	}
	if a.Address != "" {
		return a.Address
	}
	return a.Name
}

// Message satisfies mailbox.Message.
type Message struct {
	g graphMessage
}

func (m *Message) ID() string { return m.g.ID }

func (m *Message) Header(name string) string {
	switch strings.ToLower(name) {
	case "from":
		return m.g.From.header()
	case "subject":
		return m.g.Subject
	case "to":
		return joinRecips(m.g.ToRecipients)
	case "cc":
		return joinRecips(m.g.CcRecipients)
	}
	for _, h := range m.g.InternetMessageHeaders {
		if strings.EqualFold(h.Name, name) {
			return h.Value
		}
	}
	return ""
}

func (m *Message) Date() time.Time {
	t, err := time.Parse(time.RFC3339, m.g.ReceivedAt)
	if err != nil {
		return time.Time{}
	}
	return t
}

func (m *Message) BodyText(maxChars int) string {
	text := m.g.Body.Content
	if strings.EqualFold(m.g.Body.ContentType, "html") {
		text = htmlToText(text)
	}
	text = strings.TrimSpace(text)
	if text == "" {
		text = strings.TrimSpace(m.g.BodyPreview)
	}
	if maxChars > 0 && len(text) > maxChars {
		text = text[:maxChars]
	}
	return text
}

func joinRecips(rs []recip) string {
	parts := make([]string, 0, len(rs))
	for _, r := range rs {
		if h := r.header(); h != "" {
			parts = append(parts, h)
		}
	}
	return strings.Join(parts, ", ")
}

// --- mailbox.Client --------------------------------------------------------

// EnsureLabels makes sure each name exists as an Outlook master category and
// records the managed set for idempotency. Categories are their own id, so the
// returned map is name -> name. Creation is best-effort (an existing category
// is not an error).
func (c *Client) EnsureLabels(names []string) (map[string]string, error) {
	result := map[string]string{}
	for _, n := range names {
		c.managed[n] = true
		result[n] = n
		err := c.postJSON(graphBase+"/me/outlook/masterCategories",
			map[string]any{"displayName": n, "color": "preset5"}, nil)
		// 409 = category already exists: the expected idempotent case, ignore.
		// Anything else (e.g. 403 from a missing MailboxSettings scope) is a
		// real setup problem - surface it instead of silently swallowing.
		if err != nil && !isConflict(err) {
			return nil, fmt.Errorf("create master category %q: %w", n, err)
		}
	}
	return result, nil
}

// ListMessageIDs returns up to max Focused-inbox message ids that do NOT yet
// carry one of our managed categories (idempotency). The Gmail `query` is
// ignored - Outlook has no equivalent search syntax; folder + Focused scope is
// the equivalent of "in:inbox primary".
func (c *Client) ListMessageIDs(_ string, max int) ([]string, error) {
	var ids []string
	// Encode the whole query via url.Values so the space in $orderby is escaped
	// - a raw space yields a malformed request line and an HTML 400.
	//
	// Graph rejects $filter(inferenceClassification) + $orderby(receivedDateTime)
	// together ("InefficientFilter": too complex). Newest-first ordering matters
	// for the `max` cap, so keep $orderby and filter Focused client-side.
	q := url.Values{
		"$select":  {"id,categories,inferenceClassification"},
		"$orderby": {"receivedDateTime desc"},
		"$top":     {"100"},
	}
	u := fmt.Sprintf("%s/me/mailFolders/inbox/messages?%s", graphBase, q.Encode())
	for u != "" && len(ids) < max {
		var out struct {
			Value []struct {
				ID             string   `json:"id"`
				Categories     []string `json:"categories"`
				Classification string   `json:"inferenceClassification"`
			} `json:"value"`
			Next string `json:"@odata.nextLink"`
		}
		if err := c.getJSON(u, &out); err != nil {
			return nil, err
		}
		for _, m := range out.Value {
			if m.Classification != "focused" || c.hasManaged(m.Categories) {
				continue
			}
			ids = append(ids, m.ID)
			if len(ids) >= max {
				break
			}
		}
		u = out.Next
	}
	return ids, nil
}

func (c *Client) hasManaged(cats []string) bool {
	for _, cat := range cats {
		if c.managed[cat] {
			return true
		}
	}
	return false
}

// GetMessage fetches one message, or nil when unreadable.
func (c *Client) GetMessage(id string) mailbox.Message {
	u := fmt.Sprintf("%s/me/messages/%s?$select=id,subject,bodyPreview,receivedDateTime,categories,from,toRecipients,ccRecipients,body,internetMessageHeaders",
		graphBase, url.PathEscape(id))
	var g graphMessage
	raw, err := c.getRaw(u)
	if err != nil {
		return nil
	}
	if json.Unmarshal(raw, &g) != nil || g.ID == "" {
		return nil
	}
	return &Message{g: g}
}

// Trash moves a message to Deleted Items.
func (c *Client) Trash(id string) error {
	return c.move(id, "deleteditems")
}

// ApplyLabel tags the message with the category (overwrites categories, since
// fresh inbox mail rarely carries user categories); archive then moves it out
// of the inbox to the Archive folder. Category PATCH runs first because move
// changes the message id.
func (c *Client) ApplyLabel(id, category string, archive bool) error {
	if err := c.patch(fmt.Sprintf("%s/me/messages/%s", graphBase, url.PathEscape(id)),
		map[string]any{"categories": []string{category}}); err != nil {
		return err
	}
	if archive {
		return c.move(id, "archive")
	}
	return nil
}

func (c *Client) move(id, dest string) error {
	return c.postJSON(fmt.Sprintf("%s/me/messages/%s/move", graphBase, url.PathEscape(id)),
		map[string]any{"destinationId": dest}, nil)
}

// --- low-level helpers -----------------------------------------------------

func (c *Client) getRaw(u string) ([]byte, error) {
	req, _ := http.NewRequest(http.MethodGet, u, nil)
	req.Header.Set("Authorization", "Bearer "+c.accessToken)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		return nil, fmt.Errorf("graph GET HTTP %d: %s", resp.StatusCode, truncate(string(raw), 200))
	}
	return raw, nil
}

func (c *Client) getJSON(u string, out any) error {
	raw, err := c.getRaw(u)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

func (c *Client) patch(u string, body any) error {
	return c.send(http.MethodPatch, u, body, nil)
}

func (c *Client) postJSON(u string, body, out any) error {
	return c.send(http.MethodPost, u, body, out)
}

func (c *Client) send(method, u string, body, out any) error {
	var rdr io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rdr = strings.NewReader(string(b))
	}
	req, _ := http.NewRequest(method, u, rdr)
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
		return &graphError{status: resp.StatusCode, method: method, body: truncate(string(raw), 200)}
	}
	if out != nil {
		return json.Unmarshal(raw, out)
	}
	return nil
}

// graphError carries the HTTP status so callers can branch on it (e.g. treat
// 409 Conflict as an idempotent no-op) instead of string-matching messages.
type graphError struct {
	status int
	method string
	body   string
}

func (e *graphError) Error() string {
	return fmt.Sprintf("graph %s HTTP %d: %s", e.method, e.status, e.body)
}

func isConflict(err error) bool {
	var ge *graphError
	return errors.As(err, &ge) && ge.status == http.StatusConflict
}

// --- html to text ----------------------------------------------------------

var (
	reScriptStyle = regexp.MustCompile(`(?is)<(script|style)[^>]*>.*?</(script|style)>`)
	reTag         = regexp.MustCompile(`(?s)<[^>]+>`)
	reWS          = regexp.MustCompile(`[ \t]+`)
	reNL          = regexp.MustCompile(`\n{3,}`)
)

func htmlToText(s string) string {
	s = reScriptStyle.ReplaceAllString(s, " ")
	s = strings.ReplaceAll(s, "<br>", "\n")
	s = strings.ReplaceAll(s, "<br/>", "\n")
	s = strings.ReplaceAll(s, "<br />", "\n")
	s = strings.ReplaceAll(s, "</p>", "\n")
	s = strings.ReplaceAll(s, "</div>", "\n")
	s = reTag.ReplaceAllString(s, "")
	s = html.UnescapeString(s)
	s = reWS.ReplaceAllString(s, " ")
	s = reNL.ReplaceAllString(s, "\n\n")
	return strings.TrimSpace(s)
}
