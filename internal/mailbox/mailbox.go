// Package mailbox defines the provider-agnostic interfaces the organizer
// works against, so the same classify/act pipeline drives both Gmail
// (internal/gmail) and Outlook/Microsoft Graph (internal/outlook).
//
// The concept mapping for non-Gmail providers:
//   - "label" -> a provider tag (Outlook category)
//   - Trash   -> move to the provider's deleted-items
//   - archive -> remove from the inbox view
package mailbox

import "time"

// Message is the subset of an email the organizer + classifier read.
type Message interface {
	// ID is the provider's stable message id (used for actions + dedup).
	ID() string
	// Header returns a header value by name (case-insensitive), or "".
	// Providers without raw MIME headers map the common ones
	// (From/Subject/To/Cc/List-Unsubscribe) onto structured fields.
	Header(name string) string
	// BodyText returns up to maxChars of best-effort plain text.
	BodyText(maxChars int) string
	// Date is the message timestamp (zero on parse error).
	Date() time.Time
}

// Client is one account's mailbox. Method semantics match the Gmail client
// the organizer was originally written against; other providers adapt.
type Client interface {
	// EnsureLabels makes sure each managed label/category exists and returns
	// a name -> id map. For providers where the label IS its own id (Outlook
	// categories) the value equals the name.
	EnsureLabels(names []string) (map[string]string, error)
	// ListMessageIDs returns up to max candidate message ids. `query` is the
	// Gmail search string; providers that lack it ignore the value and apply
	// an equivalent scope (e.g. Outlook = Focused inbox, minus already-tagged).
	ListMessageIDs(query string, max int) ([]string, error)
	// GetMessage fetches one message, or nil (no error) when unreadable so a
	// single bad id never aborts the run.
	GetMessage(id string) Message
	// Trash moves a message to the provider's trash/deleted-items.
	Trash(id string) error
	// ApplyLabel tags a message with labelID; archive also drops it from the
	// inbox view (Gmail: remove INBOX; Outlook: move to Archive folder).
	ApplyLabel(id, labelID string, archive bool) error
}
