package gmail

import (
	"regexp"
	"strings"
)

var (
	reStyle  = regexp.MustCompile(`(?is)<style.*?</style>`)
	reScript = regexp.MustCompile(`(?is)<script.*?</script>`)
	reTag    = regexp.MustCompile(`<[^>]+>`)
	reWS     = regexp.MustCompile(`\s+`)
)

// stripHTML reduces an HTML body to readable text: drop style/script
// blocks and tags, unescape the few entities that matter, collapse
// whitespace. Mirrors stripHtmlBasic_ from the Apps Script version.
func stripHTML(html string) string {
	if html == "" {
		return ""
	}
	s := reStyle.ReplaceAllString(html, "")
	s = reScript.ReplaceAllString(s, "")
	s = reTag.ReplaceAllString(s, " ")
	r := strings.NewReplacer(
		"&nbsp;", " ",
		"&amp;", "&",
		"&lt;", "<",
		"&gt;", ">",
		"&quot;", `"`,
		"&#39;", "'",
	)
	s = r.Replace(s)
	s = reWS.ReplaceAllString(s, " ")
	return strings.TrimSpace(s)
}
