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

	"github.com/nycolas-vieira/gmail-daily-digest/internal/mailbox"
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

Decida pelo CONTEÚDO, nunca só pelo domínio. Uma mesma loja (Airbnb, iFood, Uber, Shein, Mercado Livre, banco) pode ser LIXO (propaganda) OU transacional (reserva real, comprovante, fatura) - o que manda é o corpo do email.

PROCEDIMENTO (siga NESTA ordem, pare na primeira que casar - evita inconsistência):
1. É segurança/ação crítica agora (código 2FA, reset de senha, login suspeito, conta bloqueada, pagamento falhou, chargeback)? -> URGENTE
2. É dinheiro REAL e concreto do usuário (valor em R$/US$, fatura fechada, boleto, vencimento, pagamento/cobrança confirmados, assinatura recorrente paga)? -> CONTAS
3. É um documento pra guardar (nota fiscal, recibo, contrato, comprovante, PDF fiscal/jurídico)? -> DOCUMENTO
4. É de uma PESSOA real falando direto com o usuário, OU confirmação de compra/reserva/entrega pessoal? -> PESSOAL
5. É conteúdo editorial regular que vale ler (tech/IA/negócios/dev: Substack, Medium, blog)? -> NEWSLETTER
6. É marketing/promo/social/notificação repetida sem valor? -> LIXO
7. Nenhuma das anteriores -> OUTROS (use raramente)

REGRAS QUE O MODELO COSTUMA ERRAR (preste atenção):
- CONTAS é SÓ dinheiro concreto do usuário. "Novidades do produto", "conheça o recurso X", aviso de mudança de termos, comentário de PR, alerta do Google, convite de evento NÃO são CONTAS - geralmente são LIXO ou NEWSLETTER. Sem valor monetário concreto OU vencimento real, não é CONTAS.
- CONTAS é uma dívida/pagamento que JÁ existe na vida do usuário (a fatura, o boleto, a cobrança ou o comprovante que é dele e tem valor e vencimento reais). OFERTA ou PROPOSTA de produto financeiro NÃO é CONTAS, é LIXO, mesmo citando valores: pré-aprovação de cartão/crédito, proposta de empréstimo, proposta/cotação de plano de saúde ou seguro ("Proposta para você", "liberamos condições especiais", "até X% de economia"), "renegocie/organize suas contas/dívidas", "você já tem R$ X pra usar", programa de milhas/pontos, "condições de lançamento". Proposta comercial e cotação nunca são CONTAS, ainda que pareçam fatura. Mencionar dinheiro de forma abstrata ou hipotética NÃO faz um email ser CONTAS.
- Código de uso único / OTP / código de verificação / código de acesso = sempre URGENTE, nunca CONTAS.
- Aviso operacional sem valor (mudança de limite, novo recurso, manutenção, "novidade na forma de X") NÃO é CONTAS.
- "Promoção/oferta/cupom/desconto/% OFF/imperdível/novidades/confira" = LIXO, mesmo vindo de banco, fintech, corretora ou loja.
- NUNCA invente valor, data de vencimento ou dado que não está LITERALMENTE no email. O reason deve descrever o conteúdo REAL do email recebido - se não há valor/vencimento no texto, não é CONTAS e o reason não pode citar valor.
- Sugestão de amizade, "fulano comentou", digest de rede social, "veja o que você perdeu" = LIXO.
- Pesquisa de satisfação / "avalie seu atendimento" = LIXO.
- NUNCA mande pro LIXO: email de segurança, fatura/cobrança real, documento fiscal, ou mensagem de pessoa. Na dúvida entre LIXO e algo transacional, NÃO use LIXO.
- Seja consistente: o mesmo tipo de email deve cair sempre na mesma categoria.

EXEMPLOS:
- "Débora é uma nova sugestão de amizade" (facebookmail) -> LIXO
- "O Brasil não venceu, mas você ganhou: 20% OFF no Startup Summit!" -> LIXO
- "Sua fatura do cartão fechou: R$ 1.240,00, vence 20/06" -> CONTAS (alert: vence em 72h)
- "Seu código de verificação é 884213" -> URGENTE
- "Novidades do Figma: conheça o novo modo dev" -> LIXO (NÃO CONTAS)
- "BRADESCO AMEX: Comunicado de Pré-Aprovação de cartão" -> LIXO (oferta de produto, NÃO CONTAS)
- "Você já tem o valor pra organizar suas contas" / "Renegocie sua dívida" -> LIXO (oferta de empréstimo, NÃO CONTAS)
- "Novidade na forma de juntar milhas e resgatá-las" -> LIXO (programa de pontos, NÃO CONTAS)
- "Mudança nos limites de transações no fim de semana" -> LIXO (aviso operacional sem valor)
- "The Batch: as novidades de IA da semana" (Substack) -> NEWSLETTER
- "Seu pedido do iFood saiu para entrega" -> PESSOAL
- "Nota Fiscal Eletrônica - NFe 12345 (PDF)" -> DOCUMENTO
- "Pesquisa: como foi seu atendimento na Localiza?" -> LIXO

reason: no máximo uma frase curta. alert: só quando URGENTE ou vencimento nas próximas 72h, senão deixe vazio.`

// Classify returns the Decision for a single message.
func (c *Classifier) Classify(ctx context.Context, accountName, accountEmail string, m mailbox.Message) (Decision, error) {
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
	d.MessageID = m.ID()
	d.Category = normalizeCategory(d.Category)
	return d, nil
}

func (c *Classifier) renderEmail(accountName, accountEmail string, m mailbox.Message) string {
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
