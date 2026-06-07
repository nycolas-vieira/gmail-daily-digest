// Package classify wraps a local Ollama model to categorize one email at
// a time. Single-email classification (vs the 25-per-prompt batches the
// Gemini version used) is the main quality lever for a small local model:
// the 7B model is far more reliable when it reasons about one message and
// emits one constrained JSON object than when it has to track 25 ids in a
// single response. Ollama structured outputs (the `format` JSON schema)
// pin the shape so we never parse free-form text.
package classify

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/nycolas-vieira/gmail-daily-digest/internal/gmail"
)

// Categories are the only labels the model may emit. They double as Gmail
// label names (except LIXO, which trashes).
var Categories = []string{"LIXO", "CONTAS", "NEWSLETTER", "URGENTE", "PESSOAL", "DOCUMENTO", "OUTROS"}

// Decision is the per-email verdict.
type Decision struct {
	MessageID string `json:"-"`
	Category  string `json:"category"`
	Reason    string `json:"reason"`
	Alert     string `json:"alert"`
}

// Classifier holds the Ollama connection and per-account context.
type Classifier struct {
	endpoint     string
	model        string
	maxBodyChars int
	http         *http.Client
}

// New builds a Classifier. endpoint is the Ollama base URL.
func New(endpoint, model string, maxBodyChars int) *Classifier {
	return &Classifier{
		endpoint:     strings.TrimRight(endpoint, "/"),
		model:        model,
		maxBodyChars: maxBodyChars,
		http:         &http.Client{Timeout: 120 * time.Second},
	}
}

// schema is the Ollama structured-output JSON schema pinning the response.
var schema = map[string]any{
	"type": "object",
	"properties": map[string]any{
		"category": map[string]any{"type": "string", "enum": Categories},
		"reason":   map[string]any{"type": "string"},
		"alert":    map[string]any{"type": "string"},
	},
	"required": []string{"category", "reason"},
}

const systemPrompt = `Você é um filtro inteligente de email pessoal. Recebe UM email e escolhe EXATAMENTE UMA categoria.

Decida pelo CONTEÚDO, nunca só pelo domínio. Lojas (Airbnb, iFood, Uber, Shein, Mercado Livre) podem ser LIXO (propaganda) OU não (reserva real, comprovante, pedido a caminho).

CATEGORIAS:

LIXO - apagar. Use com agressividade:
  - Propaganda/marketing puro ("confira nossas ofertas", cupom, promoção, "imperdível").
  - Notificação repetida sem valor: digests de rede social, auto-updates de ticket.
  - Newsletter genérica sem tema relevante (inspiração de design, plataforma de cupom).
  - Convite de evento cuja data já passou.
  - Cobrança de dívida genérica que claramente não é do usuário.

CONTAS - dinheiro real do usuário: fatura de cartão, boleto, assinatura recorrente (Spotify, ChatGPT, cloud), "sua conta vence em X", "pagamento confirmado de R$ X". Se vence nas próximas 72h, preencha alert "Conta <nome> vence em <data>".

NEWSLETTER - conteúdo editorial regular que vale ler (tech, IA, negócios, dev): Substack, Medium digest, blog. Corpo longo, não-transacional, normalmente com List-Unsubscribe.

URGENTE - ação crítica de curto prazo, em especial segurança: reset de senha, código 2FA, login suspeito, conta bloqueada, pagamento falhou, disputa/chargeback, suspensão iminente. SEMPRE preencha alert descrevendo a urgência.

PESSOAL - email de PESSOA (não bot/marketing) sobre assunto pessoal: amigo, família, conversa direta. Também confirmação de compra/reserva pessoal (reserva Airbnb confirmada, pedido iFood entregue).

DOCUMENTO - vira registro/arquivo: nota fiscal, recibo, contrato, comprovante de pagamento, PDF jurídico/fiscal.

OUTROS - só o que realmente não cabe acima. Use raramente; tente as 6 categorias antes.

reason: no máximo uma frase curta. alert: só quando URGENTE ou vencimento próximo, senão deixe vazio.`

// Classify returns the Decision for a single message.
func (c *Classifier) Classify(ctx context.Context, accountName, accountEmail string, m *gmail.Message) (Decision, error) {
	user := c.renderEmail(accountName, accountEmail, m)

	reqBody := map[string]any{
		"model": c.model,
		"messages": []map[string]string{
			{"role": "system", "content": systemPrompt},
			{"role": "user", "content": user},
		},
		"stream":  false,
		"format":  schema,
		"options": map[string]any{"temperature": 0.1},
	}
	raw, err := json.Marshal(reqBody)
	if err != nil {
		return Decision{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.endpoint+"/api/chat", bytes.NewReader(raw))
	if err != nil {
		return Decision{}, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return Decision{}, fmt.Errorf("ollama request (is `ollama serve` running?): %w", err)
	}
	defer resp.Body.Close()

	var out struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
		Error string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return Decision{}, fmt.Errorf("ollama decode: %w", err)
	}
	if out.Error != "" {
		return Decision{}, fmt.Errorf("ollama: %s", out.Error)
	}

	var d Decision
	if err := json.Unmarshal([]byte(out.Message.Content), &d); err != nil {
		return Decision{}, fmt.Errorf("parse model output %q: %w", truncate(out.Message.Content, 200), err)
	}
	d.MessageID = m.ID
	d.Category = normalizeCategory(d.Category)
	return d, nil
}

func (c *Classifier) renderEmail(accountName, accountEmail string, m *gmail.Message) string {
	from := m.Header("From")
	subj := m.Header("Subject")
	if subj == "" {
		subj = "(sem assunto)"
	}
	hasUnsub := "no"
	if m.Header("List-Unsubscribe") != "" {
		hasUnsub = "yes"
	}
	date := ""
	if t := m.Date(); !t.IsZero() {
		date = t.Format(time.RFC3339)
	}
	body := m.BodyText(c.maxBodyChars)
	return fmt.Sprintf(
		"Conta: %s (%s)\nFrom: %s\nSubject: %s\nDate: %s\nList-Unsubscribe: %s\n\nCorpo:\n%s",
		accountName, accountEmail, from, subj, date, hasUnsub, body,
	)
}

func normalizeCategory(cat string) string {
	cat = strings.ToUpper(strings.TrimSpace(cat))
	for _, c := range Categories {
		if c == cat {
			return cat
		}
	}
	return "OUTROS"
}

// Ping checks Ollama is reachable and the model is present, so a run fails
// fast with a clear message instead of erroring per-email.
func (c *Classifier) Ping(ctx context.Context) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.endpoint+"/api/tags", nil)
	if err != nil {
		return err
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("ollama unreachable at %s (run `ollama serve`): %w", c.endpoint, err)
	}
	defer resp.Body.Close()
	var tags struct {
		Models []struct {
			Name string `json:"name"`
		} `json:"models"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&tags); err != nil {
		return fmt.Errorf("ollama /api/tags decode: %w", err)
	}
	for _, mdl := range tags.Models {
		if mdl.Name == c.model || strings.HasPrefix(mdl.Name, c.model+":") || mdl.Name == c.model+":latest" {
			return nil
		}
	}
	return fmt.Errorf("ollama model %q not found (run `ollama pull %s`)", c.model, c.model)
}

func truncate(s string, n int) string {
	if len(s) > n {
		return s[:n]
	}
	return s
}
