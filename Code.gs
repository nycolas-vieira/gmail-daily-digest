// ============================================================
// gmail-daily-digest v2.0.0 - Gmail Organizer
// Roda no Apps Script GCP, multi-conta via OAuth refresh tokens.
//
// Jobs:
//   - cleanAndLabel_() (hourly): categoriza com Gemini e aplica acoes
//     (Trash, Label) em emails da inbox de todas as contas. Persiste
//     contadores em ScriptProperties.
//   - generateReport_() (07:00 e 19:00 BRT): consolida contadores
//     desde o ultimo report, salva markdown no Drive e zera contadores.
//
// Categorias (sao tambem nomes de labels Gmail aplicaveis):
//   LIXO       -> move pro Trash (Gmail purga em 30d)
//   CONTAS     -> label "Contas" (faturas, billing, vencimentos)
//   NEWSLETTER -> label "Newsletter" (digests editoriais)
//   URGENTE    -> label "Urgentes" (security, password reset, locked)
//   PESSOAL    -> label "Pessoais" (familia, amigos, nao-pro)
//   DOCUMENTO  -> label "Documentos" (NF, contratos, reservas)
//   OUTROS     -> label "Outros" (tudo o que nao cabe acima)
// ============================================================

const CONFIG = {
  GEMINI_API_KEY: PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'),
  GEMINI_MODEL: 'gemini-2.5-flash',
  MAX_BODY_CHARS: 1200,
  MAX_EMAILS_PER_RUN: 80,

  // Multi-account config (same scheme as v1):
  //   ACCOUNTS_CONFIG = "personal:personal@example.com,moonxi:work@example.com,..."
  //   refresh tokens em REFRESH_TOKEN_<NAME_UPPER>.
  ACCOUNTS: (PropertiesService.getScriptProperties().getProperty('ACCOUNTS_CONFIG') || '').split(',').filter(Boolean).map(entry => {
    const [name, email] = entry.trim().split(':');
    return { name, email, tokenKey: `REFRESH_TOKEN_${name.toUpperCase()}` };
  }),

  // Two-tier sender blocklist:
  //
  //   HARD_TRASH_SENDERS  -> auto-trash, no review, no Gemini call.
  //                          Reserved for senders the user has explicitly
  //                          confirmed are 100% junk. Bootstraps from the
  //                          v1 `BLACK_LIST` property if empty.
  //
  //   SOFT_TRASH_SENDERS  -> skip Gemini, but apply label "Revisar" instead
  //                          of trashing. The user reviews the Revisar
  //                          label periodically and either promotes the
  //                          sender to HARD (via `promoteSoftToHard()`) or
  //                          removes it from SOFT if the classification
  //                          was wrong.
  //
  // Auto-learn target is SOFT: whenever Gemini classifies an email as LIXO,
  // the sender is added to SOFT (not HARD) so the next email from that
  // sender is shown for review instead of being silently dropped. The user
  // promotes after confidence.
  HARD_TRASH_SENDERS: (
    PropertiesService.getScriptProperties().getProperty('HARD_TRASH_SENDERS')
    || PropertiesService.getScriptProperties().getProperty('BLACK_LIST')
    || ''
  ).split(',').map(s => s.trim().toLowerCase()).filter(Boolean),

  SOFT_TRASH_SENDERS: (PropertiesService.getScriptProperties().getProperty('SOFT_TRASH_SENDERS') || '')
    .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),

  // Senders that look like newsletters by header but are transactional.
  // Used to override the List-Unsubscribe heuristic in the prompt context.
  NEWSLETTER_DENYLIST: [
    'noreply@github.com', 'notifications@github.com',
    'billing@service.example', 'security@service.example',
    'noreply@service.example', 'noreply@provider.example',
    'noreply@accounts.example', 'security@social.example',
    '@itau.com.br', '@santander.com.br', '@bradesco.com.br',
    '@nubank.com.br', '@mercadopago.com', '@paypal.com',
    '@stripe.com', '@aws.amazon.com',
  ],

  // Drive folder name where reports land.
  REPORT_FOLDER_NAME: 'gmail-organizer-reports',

  // Where reports are mirrored to in Markdown.
  TZ: 'America/Sao_Paulo',
};

const CATEGORIES = ['LIXO', 'CONTAS', 'NEWSLETTER', 'URGENTE', 'PESSOAL', 'DOCUMENTO', 'OUTROS'];

const LABEL_NAMES = {
  CONTAS: 'Contas',
  NEWSLETTER: 'Newsletter',
  URGENTE: 'Urgentes',
  PESSOAL: 'Pessoais',
  DOCUMENTO: 'Documentos',
  OUTROS: 'Outros',
  REVISAR: 'Revisar',
};

// ============================================================
// ENTRY POINTS
// ============================================================

/**
 * Hourly job: scan each account inbox, categorize fresh emails with Gemini,
 * apply labels and trash LIXO. Skips emails already labeled by us (idempotent).
 */
function cleanAndLabel_() {
  Logger.log(`[cleanAndLabel] Contas: ${CONFIG.ACCOUNTS.map(a => a.name).join(', ')}`);
  if (CONFIG.ACCOUNTS.length === 0) {
    Logger.log('No accounts configured (ACCOUNTS_CONFIG empty).');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  for (const acct of CONFIG.ACCOUNTS) {
    try {
      processAccount_(acct, props);
    } catch (e) {
      Logger.log(`[${acct.name}] FAIL ${e.message}\n${e.stack}`);
      incrementStat_(`STATS_ERRORS_${acct.name.toUpperCase()}`, 1);
    }
  }
}

/**
 * Time-driven 07:00 + 19:00 BRT. Reads stats accumulated since the last
 * report, renders a Markdown summary, saves to Drive, then resets counters.
 */
function generateReport_() {
  const props = PropertiesService.getScriptProperties();
  const stats = readStats_(props);
  const now = new Date();
  const reportDateStr = Utilities.formatDate(now, CONFIG.TZ, "yyyy-MM-dd-HH'h'");
  const periodStart = stats.periodStart ? new Date(stats.periodStart) : null;

  const md = buildReportMarkdown_(stats, periodStart, now);
  const filename = `${reportDateStr}.md`;
  const file = saveReportToDrive_(filename, md);
  Logger.log(`[report] Saved: ${file.getUrl()}`);

  // Reset period
  resetStats_(props, now);
}

/** Manual test - safe to run from the IDE. */
function testCleanAndLabel() {
  cleanAndLabel_();
}

/** Manual test - generates a report from current counters without resetting. */
function testReportPreview() {
  const props = PropertiesService.getScriptProperties();
  const stats = readStats_(props);
  const periodStart = stats.periodStart ? new Date(stats.periodStart) : null;
  const md = buildReportMarkdown_(stats, periodStart, new Date());
  Logger.log(md);
}

// ============================================================
// PER-ACCOUNT PROCESSING
// ============================================================

function processAccount_(acct, props) {
  const refreshToken = props.getProperty(acct.tokenKey);
  if (!refreshToken) {
    Logger.log(`[${acct.name}] missing refresh token (${acct.tokenKey})`);
    return;
  }
  const accessToken = getAccessToken_(refreshToken);

  // 1. Ensure the 6 labels we use all exist (cache the id map per run).
  const labelMap = ensureLabelsExist_(accessToken);
  const labelIds = Object.values(labelMap);

  // 2. Fetch fresh inbox messages NOT already touched by us. The exclusion
  //    on existing labels keeps the job idempotent across hourly runs.
  const labelExclusion = Object.values(LABEL_NAMES).map(n => `-label:${quoteLabel_(n)}`).join(' ');
  const query = `in:inbox -in:trash newer_than:7d ${labelExclusion}`;
  const messageIds = listMessageIds_(accessToken, query, CONFIG.MAX_EMAILS_PER_RUN);
  Logger.log(`[${acct.name}] ${messageIds.length} candidate(s)`);
  if (messageIds.length === 0) return;

  // 3. Hydrate. Before paying Gemini, apply the two sender-list shortcuts:
  //    HARD -> trash immediately, SOFT -> label "Revisar" for manual review.
  const fetched = [];
  for (const id of messageIds) {
    const msg = fetchMessage_(accessToken, id);
    if (!msg) continue;
    const from = headerOf_(msg, 'From').toLowerCase();
    if (isHardTrash_(from)) {
      trashMessage_(accessToken, id);
      incrementStat_(`STATS_TRASHED_${acct.name.toUpperCase()}`, 1);
      incrementStat_('STATS_TRASHED_TOTAL', 1);
      incrementStat_('STATS_LIXO_HARD', 1);
      Logger.log(`[${acct.name}] hard-trash ${from}`);
      continue;
    }
    if (isSoftTrash_(from)) {
      const revisarId = labelMap[LABEL_NAMES.REVISAR];
      if (revisarId) {
        applyLabel_(accessToken, id, revisarId);
        incrementStat_(`STATS_LABEL_${LABEL_NAMES.REVISAR.toUpperCase()}`, 1);
        incrementStat_('STATS_LABELED_TOTAL', 1);
      }
      Logger.log(`[${acct.name}] soft-trash (review) ${from}`);
      continue;
    }
    fetched.push(msg);
  }
  if (fetched.length === 0) return;

  // 4. Categorize via Gemini, in chunks of 25 to keep prompts tight.
  const decisions = [];
  const chunkSize = 25;
  for (let i = 0; i < fetched.length; i += chunkSize) {
    const chunk = fetched.slice(i, i + chunkSize);
    try {
      const chunkDecisions = categorizeEmails_(chunk, acct);
      decisions.push(...chunkDecisions);
    } catch (e) {
      Logger.log(`[${acct.name}] Gemini chunk ${i} failed: ${e.message}`);
    }
  }

  // 5. Apply actions and collect alerts. Keep a quick map of msgId -> From
  //    so the LIXO branch can teach HARD_TRASH_SENDERS the sender.
  const fromById = {};
  fetched.forEach(m => { fromById[m.id] = headerOf_(m, 'From'); });

  const alerts = [];
  for (const d of decisions) {
    if (!d || !d.messageId) continue;
    const cat = (d.category || 'OUTROS').toUpperCase();
    if (cat === 'LIXO') {
      trashMessage_(accessToken, d.messageId);
      incrementStat_(`STATS_TRASHED_${acct.name.toUpperCase()}`, 1);
      incrementStat_('STATS_TRASHED_TOTAL', 1);
      const learned = learnSoftTrashSender_(fromById[d.messageId]);
      if (learned) Logger.log(`[${acct.name}] learned SOFT_TRASH ${learned}`);
    } else {
      const labelName = LABEL_NAMES[cat] || LABEL_NAMES.OUTROS;
      const labelId = labelMap[labelName];
      if (labelId) {
        applyLabel_(accessToken, d.messageId, labelId);
        incrementStat_(`STATS_LABEL_${labelName.toUpperCase()}`, 1);
        incrementStat_('STATS_LABELED_TOTAL', 1);
      }
    }
    if (d.alert) {
      alerts.push(`${acct.name}: ${d.alert}`);
    }
  }
  if (alerts.length) {
    appendAlerts_(alerts);
  }
  Logger.log(`[${acct.name}] processed=${decisions.length} alerts=${alerts.length}`);
}

// ============================================================
// GEMINI CATEGORIZATION
// ============================================================

function categorizeEmails_(messages, acct) {
  const lines = messages.map((msg, i) => {
    const from = headerOf_(msg, 'From');
    const subj = headerOf_(msg, 'Subject') || '(sem assunto)';
    const date = new Date(parseInt(msg.internalDate)).toISOString();
    const bodies = extractBodies_(msg.payload);
    const text = (bodies.plain || stripHtmlBasic_(bodies.html || '')).substring(0, CONFIG.MAX_BODY_CHARS);
    const hasUnsub = headerOf_(msg, 'List-Unsubscribe') ? 'yes' : 'no';
    const labels = (msg.labelIds || []).join(',');
    return `[#${i}] id=${msg.id}\nFrom: ${from}\nSubject: ${subj}\nDate: ${date}\nList-Unsubscribe: ${hasUnsub}\nGmail-labels: ${labels}\nBody:\n${text}\n---`;
  }).join('\n\n');

  const prompt = `Voce e um filtro inteligente de email pessoal multi-conta.
Conta atual: ${acct.name} (${acct.email}).

REGRAS DE CATEGORIZACAO (escolha exatamente UMA categoria por email):

LIXO - APAGAR. Use AGRESSIVAMENTE quando o email e:
  - Propaganda/marketing puro (lojas tipo Shein, Natura, Catarse, OKX, Airbnb promo, Super Pizza Pan, etc).
  - Notificacao repetida sem valor: GitHub PR review notifications, Jira ticket auto-updates, social network digests.
  - Invite passado: convite de evento cuja data ja passou.
  - Newsletter generica sem tema relevante (e.g. coupons platforms, Dribbble inspiration).
  - Renegociacao de divida que nao e do usuario, "acordo digital" cobranca generica.
  IMPORTANTE: Airbnb/iFood/Uber/Shein etc PODEM SER LIXO (propaganda) OU NAO-LIXO (reserva real, comprovante de compra). DECIDA pelo conteudo, nao pelo dominio. Se houver codigo de reserva, data futura, valor pago -> DOCUMENTO ou PESSOAL. Se for "Confira nossas ofertas" -> LIXO.

CONTAS - Faturas, billing, vencimentos, cobrancas reais do usuario.
  - Fatura de cartao, boleto bancario, assinatura recorrente (Spotify, ChatGPT, Cloud).
  - "Sua conta vence em X dias", "Pagamento confirmado de R$ X".
  - Se o email indica VENCIMENTO PROXIMO (proximas 72h), preencha "alert" com "Conta <nome> vence em <data>".

NEWSLETTER - Conteudo editorial regular (substack, blogs, Medium digests, etc).
  - Tema de interesse: tech, AI, business, dev.
  - List-Unsubscribe presente + corpo de texto longo e nao-transacional.

URGENTE - Acao critica em curto prazo, especialmente security.
  - Password reset, codigo 2FA, account locked, suspicious sign-in, billing failed.
  - Disputas/chargebacks, suspensao de servico iminente.
  - Sempre preencha "alert" descrevendo a urgencia.

PESSOAL - Emails de pessoas (nao bots/marketing) sobre assuntos pessoais.
  - Amigos, familia, conversa direta nao-profissional.
  - Confirmacao de compra/reserva pessoal (Airbnb booking confirmation, iFood pedido entregue).

DOCUMENTO - Itens que viram registro/arquivo.
  - Nota fiscal, recibo, contrato, comprovante de pagamento.
  - PDFs juridicos/fiscais anexados.

OUTROS - O que nao cabe acima. Use raramente; tente classificar nas 6 categorias acima primeiro.

OUTPUT: JSON estrito.

{
  "results": [
    {"messageId": "<gmail msg id literal>", "category": "LIXO|CONTAS|NEWSLETTER|URGENTE|PESSOAL|DOCUMENTO|OUTROS", "reason": "<<= 1 frase>>", "alert": "<<opcional, so se urgente ou vencimento proximo>>"}
  ]
}

Emails:
${lines}

Responda APENAS o JSON, sem markdown.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 8192, responseMimeType: 'application/json' },
    }),
    muteHttpExceptions: true,
  });

  const body = JSON.parse(resp.getContentText());
  if (body.error) throw new Error(`Gemini: ${body.error.message}`);
  const text = body.candidates[0].content.parts[0].text;
  const parsed = safeParseJson_(text);
  return (parsed && Array.isArray(parsed.results)) ? parsed.results : [];
}

// ============================================================
// GMAIL API HELPERS
// ============================================================

function listMessageIds_(accessToken, query, maxResults) {
  const ids = [];
  let pageToken = null;
  do {
    let url = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${Math.min(100, maxResults - ids.length)}`;
    if (pageToken) url += `&pageToken=${pageToken}`;
    const r = UrlFetchApp.fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, muteHttpExceptions: true });
    const j = JSON.parse(r.getContentText());
    if (j.error) throw new Error(`list: ${j.error.message}`);
    (j.messages || []).forEach(m => ids.push(m.id));
    pageToken = j.nextPageToken || null;
  } while (pageToken && ids.length < maxResults);
  return ids;
}

function fetchMessage_(accessToken, id) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`;
  const r = UrlFetchApp.fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText());
  if (j.error) {
    Logger.log(`fetchMessage ${id}: ${j.error.message}`);
    return null;
  }
  return j;
}

function trashMessage_(accessToken, id) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/trash`;
  const r = UrlFetchApp.fetch(url, { method: 'post', headers: { Authorization: `Bearer ${accessToken}` }, muteHttpExceptions: true });
  if (r.getResponseCode() >= 300) {
    Logger.log(`trash ${id}: HTTP ${r.getResponseCode()} ${r.getContentText()}`);
  }
}

function applyLabel_(accessToken, id, labelId) {
  const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}/modify`;
  const r = UrlFetchApp.fetch(url, {
    method: 'post',
    headers: { Authorization: `Bearer ${accessToken}` },
    contentType: 'application/json',
    payload: JSON.stringify({ addLabelIds: [labelId] }),
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() >= 300) {
    Logger.log(`label ${id} -> ${labelId}: HTTP ${r.getResponseCode()} ${r.getContentText()}`);
  }
}

function ensureLabelsExist_(accessToken) {
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/labels';
  const r = UrlFetchApp.fetch(url, { headers: { Authorization: `Bearer ${accessToken}` }, muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText());
  if (j.error) throw new Error(`labels list: ${j.error.message}`);

  const byName = {};
  (j.labels || []).forEach(l => { byName[l.name] = l.id; });

  const result = {};
  for (const name of Object.values(LABEL_NAMES)) {
    if (byName[name]) {
      result[name] = byName[name];
      continue;
    }
    const create = UrlFetchApp.fetch(url, {
      method: 'post',
      headers: { Authorization: `Bearer ${accessToken}` },
      contentType: 'application/json',
      payload: JSON.stringify({ name, labelListVisibility: 'labelShow', messageListVisibility: 'show' }),
      muteHttpExceptions: true,
    });
    const created = JSON.parse(create.getContentText());
    if (created.error) {
      Logger.log(`Could not create label ${name}: ${created.error.message}`);
      continue;
    }
    result[name] = created.id;
    Logger.log(`Created label ${name} id=${created.id}`);
  }
  return result;
}

function headerOf_(msg, name) {
  const headers = (msg.payload && msg.payload.headers) || [];
  const h = headers.find(x => x.name.toLowerCase() === name.toLowerCase());
  return h ? (h.value || '') : '';
}

function isHardTrash_(fromLower) {
  if (!fromLower) return false;
  return CONFIG.HARD_TRASH_SENDERS.some(needle => fromLower.includes(needle));
}

function isSoftTrash_(fromLower) {
  if (!fromLower) return false;
  return CONFIG.SOFT_TRASH_SENDERS.some(needle => fromLower.includes(needle));
}

/**
 * Extract the bare email from a "Name <addr>" header and add it to
 * SOFT_TRASH_SENDERS if not already covered there OR in HARD. Returns the
 * address that was added (for stats), or null if already known.
 *
 * Auto-learn defaults to SOFT (not HARD) so the next email from this
 * sender is shown for review under the "Revisar" label instead of being
 * silently dropped. The user promotes confirmed-junk senders to HARD via
 * `promoteSoftToHard()`.
 */
function learnSoftTrashSender_(fromHeader) {
  if (!fromHeader) return null;
  const props = PropertiesService.getScriptProperties();
  const soft = (props.getProperty('SOFT_TRASH_SENDERS') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const hard = (props.getProperty('HARD_TRASH_SENDERS')
              || props.getProperty('BLACK_LIST')
              || '').split(',').map(s => s.trim()).filter(Boolean);
  const lower = fromHeader.toLowerCase();
  const angle = lower.match(/<([^>]+)>/);
  const addr = (angle ? angle[1] : lower).trim();
  if (!addr || !addr.includes('@')) return null;
  // Already covered by either tier?
  if (hard.some(n => addr.includes(n.toLowerCase()))) return null;
  if (soft.some(n => addr.includes(n.toLowerCase()))) return null;
  soft.push(addr);
  props.setProperty('SOFT_TRASH_SENDERS', soft.join(','));
  const added = JSON.parse(props.getProperty('STATS_SOFT_TRASH_ADDED') || '[]');
  added.push(addr);
  props.setProperty('STATS_SOFT_TRASH_ADDED', JSON.stringify(added));
  return addr;
}

/**
 * One-shot migration: move addresses listed in property MIGRATE_HARD_TO_SOFT
 * from HARD to SOFT (good for demoting auto-learned senders that turned out
 * to be dual-use, e.g. sender@vendor.example). Property is cleared after run.
 */
function migrateHardToSoft() {
  const props = PropertiesService.getScriptProperties();
  const csv = props.getProperty('MIGRATE_HARD_TO_SOFT') || '';
  if (!csv) {
    Logger.log('Set MIGRATE_HARD_TO_SOFT property first (CSV of substrings to demote).');
    return;
  }
  const toMove = csv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const hard = (props.getProperty('HARD_TRASH_SENDERS')
              || props.getProperty('BLACK_LIST')
              || '').split(',').map(s => s.trim()).filter(Boolean);
  const soft = (props.getProperty('SOFT_TRASH_SENDERS') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const stayInHard = [];
  let moved = 0;
  for (const h of hard) {
    if (toMove.some(m => h.toLowerCase().includes(m))) {
      if (!soft.some(s => s.toLowerCase() === h.toLowerCase())) soft.push(h);
      moved++;
    } else {
      stayInHard.push(h);
    }
  }
  props.setProperty('HARD_TRASH_SENDERS', stayInHard.join(','));
  props.setProperty('SOFT_TRASH_SENDERS', soft.join(','));
  props.deleteProperty('MIGRATE_HARD_TO_SOFT');
  Logger.log(`Migrated ${moved} sender(s) HARD -> SOFT. HARD=${stayInHard.length} SOFT=${soft.length}.`);
}

/**
 * v2.1.0 one-shot: demote the 5 senders that were auto-learned as HARD
 * during the 2026-05-21 production run but are actually dual-use
 * (Fireflies notifications, GCP billing, GitHub security, Oracle account,
 * Teams meeting reminders). Safe to re-run - already-migrated entries
 * are no-ops.
 */
function applyV21Migration_oneshot() {
  PropertiesService.getScriptProperties().setProperty(
    'MIGRATE_HARD_TO_SOFT',
    'sender@vendor.example,cloud@service.example,notifications@github.com,replies@vendor.example,noreply@teams.example'
  );
  migrateHardToSoft();
}

/**
 * One-shot promotion: move addresses listed in property PROMOTE_SOFT_TO_HARD
 * from SOFT to HARD (after the user reviewed Revisar emails and confirmed
 * they are truly junk). Property is cleared after run.
 */
function promoteSoftToHard() {
  const props = PropertiesService.getScriptProperties();
  const csv = props.getProperty('PROMOTE_SOFT_TO_HARD') || '';
  if (!csv) {
    Logger.log('Set PROMOTE_SOFT_TO_HARD property first (CSV of substrings to promote).');
    return;
  }
  const toMove = csv.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
  const soft = (props.getProperty('SOFT_TRASH_SENDERS') || '')
    .split(',').map(s => s.trim()).filter(Boolean);
  const hard = (props.getProperty('HARD_TRASH_SENDERS')
              || props.getProperty('BLACK_LIST')
              || '').split(',').map(s => s.trim()).filter(Boolean);
  const stayInSoft = [];
  let moved = 0;
  for (const s of soft) {
    if (toMove.some(m => s.toLowerCase().includes(m))) {
      if (!hard.some(h => h.toLowerCase() === s.toLowerCase())) hard.push(s);
      moved++;
    } else {
      stayInSoft.push(s);
    }
  }
  props.setProperty('SOFT_TRASH_SENDERS', stayInSoft.join(','));
  props.setProperty('HARD_TRASH_SENDERS', hard.join(','));
  props.deleteProperty('PROMOTE_SOFT_TO_HARD');
  Logger.log(`Promoted ${moved} sender(s) SOFT -> HARD. HARD=${hard.length} SOFT=${stayInSoft.length}.`);
}

function quoteLabel_(name) {
  // Gmail search labels with spaces need quoting.
  return name.includes(' ') ? `"${name}"` : name;
}

// ============================================================
// STATS COUNTERS (ScriptProperties)
// ============================================================

function incrementStat_(key, delta) {
  const props = PropertiesService.getScriptProperties();
  const current = parseInt(props.getProperty(key) || '0', 10);
  props.setProperty(key, String(current + delta));
}

function appendAlerts_(alerts) {
  const props = PropertiesService.getScriptProperties();
  const existing = JSON.parse(props.getProperty('STATS_ALERTS') || '[]');
  existing.push(...alerts);
  // Cap to 100 to avoid runaway property growth.
  props.setProperty('STATS_ALERTS', JSON.stringify(existing.slice(-100)));
}

function readStats_(props) {
  const out = {
    periodStart: props.getProperty('STATS_PERIOD_START'),
    trashedTotal: parseInt(props.getProperty('STATS_TRASHED_TOTAL') || '0', 10),
    labeledTotal: parseInt(props.getProperty('STATS_LABELED_TOTAL') || '0', 10),
    lixoHard: parseInt(props.getProperty('STATS_LIXO_HARD') || '0', 10),
    perAccount: {},
    perLabel: {},
    errorsByAccount: {},
    alerts: JSON.parse(props.getProperty('STATS_ALERTS') || '[]'),
    softTrashAdded: JSON.parse(props.getProperty('STATS_SOFT_TRASH_ADDED') || '[]'),
  };
  for (const acct of CONFIG.ACCOUNTS) {
    out.perAccount[acct.name] = parseInt(props.getProperty(`STATS_TRASHED_${acct.name.toUpperCase()}`) || '0', 10);
    out.errorsByAccount[acct.name] = parseInt(props.getProperty(`STATS_ERRORS_${acct.name.toUpperCase()}`) || '0', 10);
  }
  for (const label of Object.values(LABEL_NAMES)) {
    out.perLabel[label] = parseInt(props.getProperty(`STATS_LABEL_${label.toUpperCase()}`) || '0', 10);
  }
  return out;
}

function resetStats_(props, now) {
  const keysToClear = [
    'STATS_TRASHED_TOTAL', 'STATS_LABELED_TOTAL', 'STATS_LIXO_HARD', 'STATS_ALERTS',
    'STATS_SOFT_TRASH_ADDED',
  ];
  for (const acct of CONFIG.ACCOUNTS) {
    keysToClear.push(`STATS_TRASHED_${acct.name.toUpperCase()}`);
    keysToClear.push(`STATS_ERRORS_${acct.name.toUpperCase()}`);
  }
  for (const label of Object.values(LABEL_NAMES)) {
    keysToClear.push(`STATS_LABEL_${label.toUpperCase()}`);
  }
  keysToClear.forEach(k => props.deleteProperty(k));
  props.setProperty('STATS_PERIOD_START', now.toISOString());
}

// ============================================================
// REPORT RENDERING + DRIVE PERSISTENCE
// ============================================================

function buildReportMarkdown_(stats, periodStart, now) {
  const tz = CONFIG.TZ;
  const fmt = (d) => d ? Utilities.formatDate(d, tz, "yyyy-MM-dd HH:mm") : '(inicio)';
  const lines = [];
  lines.push('---');
  lines.push(`summary: Gmail organizer report ${Utilities.formatDate(now, tz, "yyyy-MM-dd HH:mm")}`);
  lines.push('tags: [gmail, organizer, report]');
  lines.push(`created: ${Utilities.formatDate(now, tz, 'yyyy-MM-dd')}`);
  lines.push(`updated: ${Utilities.formatDate(now, tz, 'yyyy-MM-dd')}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Gmail Organizer - ${Utilities.formatDate(now, tz, "yyyy-MM-dd HH:mm")}`);
  lines.push('');
  lines.push(`**Periodo:** ${fmt(periodStart)} -> ${fmt(now)}`);
  lines.push('');

  // Trashed
  lines.push('## Apagados');
  if (stats.trashedTotal === 0) {
    lines.push('- (nenhum)');
  } else {
    const parts = Object.entries(stats.perAccount)
      .filter(([_, n]) => n > 0)
      .map(([acct, n]) => `${n} ${acct}`);
    lines.push(`- **Total:** ${stats.trashedTotal} (${parts.join(', ') || 'desconhecido'})`);
    if (stats.lixoHard > 0) {
      lines.push(`- Sender hard-block: ${stats.lixoHard}`);
    }
  }
  lines.push('');

  // Labeled
  lines.push('## Catalogados');
  if (stats.labeledTotal === 0) {
    lines.push('- (nenhum)');
  } else {
    const parts = Object.entries(stats.perLabel)
      .filter(([_, n]) => n > 0)
      .map(([label, n]) => `${n} ${label}`);
    lines.push(`- **Total:** ${stats.labeledTotal} (${parts.join(', ') || 'desconhecido'})`);
  }
  lines.push('');

  // Soft trash additions - auto-learned senders, now under label "Revisar"
  // for manual review. Promote to HARD via `promoteSoftToHard()` once
  // confirmed; remove from SOFT_TRASH_SENDERS if Gemini was wrong.
  lines.push('## Adicionados ao SOFT_TRASH_SENDERS (para revisao)');
  if (stats.softTrashAdded.length === 0) {
    lines.push('- (nenhum)');
  } else {
    const unique = Array.from(new Set(stats.softTrashAdded));
    unique.forEach(addr => lines.push(`- ${addr}`));
    lines.push('');
    lines.push('> Esses senders agora recebem a label `Revisar` (nao vao pro trash). Reveja-os no Gmail.');
    lines.push('> - Confirmou que sao lixo? Promova pra HARD: set property `PROMOTE_SOFT_TO_HARD` = csv e rode `promoteSoftToHard()`.');
    lines.push('> - Foi falso positivo? Edite a property `SOFT_TRASH_SENDERS` removendo o endereco.');
  }
  lines.push('');

  // Revisar label volume - signal that the user has stuff to triage
  const revisarCount = stats.perLabel[LABEL_NAMES.REVISAR] || 0;
  if (revisarCount > 0) {
    lines.push(`## Em revisao (label \`Revisar\`)`);
    lines.push(`- **${revisarCount}** email(s) labeled como Revisar no periodo.`);
    lines.push('');
  }

  // Alerts
  lines.push('## Alertas');
  if (stats.alerts.length === 0) {
    lines.push('- (nenhum)');
  } else {
    stats.alerts.forEach(a => lines.push(`- ${a}`));
  }
  lines.push('');

  // Errors
  const errAccts = Object.entries(stats.errorsByAccount).filter(([_, n]) => n > 0);
  if (errAccts.length > 0) {
    lines.push('## Erros');
    errAccts.forEach(([acct, n]) => lines.push(`- ${acct}: ${n}`));
    lines.push('');
  }

  return lines.join('\n');
}

function saveReportToDrive_(filename, content) {
  const folder = getOrCreateReportFolder_();
  const blob = Utilities.newBlob(content, 'text/markdown', filename);
  return folder.createFile(blob);
}

function getOrCreateReportFolder_() {
  const props = PropertiesService.getScriptProperties();
  const cached = props.getProperty('REPORT_FOLDER_ID');
  if (cached) {
    try {
      return DriveApp.getFolderById(cached);
    } catch (e) {
      // Folder gone; fall through to recreate.
    }
  }
  // Search by name (case-insensitive). Only files created by this app
  // are visible under drive.file scope, so first run creates a new one.
  const folders = DriveApp.getFoldersByName(CONFIG.REPORT_FOLDER_NAME);
  let folder;
  if (folders.hasNext()) {
    folder = folders.next();
  } else {
    folder = DriveApp.createFolder(CONFIG.REPORT_FOLDER_NAME);
  }
  props.setProperty('REPORT_FOLDER_ID', folder.getId());
  return folder;
}

// ============================================================
// OAUTH (Gmail multi-account, same scheme as v1)
// ============================================================

function getAccessToken_(refreshToken) {
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('OAUTH_CLIENT_ID');
  const clientSecret = props.getProperty('OAUTH_CLIENT_SECRET');
  const resp = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    },
    muteHttpExceptions: true,
  });
  const j = JSON.parse(resp.getContentText());
  if (j.error) throw new Error(`OAuth: ${j.error} - ${j.error_description}`);
  return j.access_token;
}

// ============================================================
// BODY EXTRACTION + HTML CLEANUP (kept from v1)
// ============================================================

function extractBodies_(payload) {
  let plain = '';
  let html = '';
  function walk(p) {
    if (!p) return;
    const mime = p.mimeType || '';
    const data = (p.body && p.body.data) || '';
    if (mime === 'text/plain' && data) {
      plain += Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString();
    } else if (mime === 'text/html' && data) {
      html += Utilities.newBlob(Utilities.base64DecodeWebSafe(data)).getDataAsString();
    }
    (p.parts || []).forEach(walk);
  }
  walk(payload);
  return { plain, html };
}

function stripHtmlBasic_(html) {
  if (!html) return '';
  return html.replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

// ============================================================
// MISC HELPERS
// ============================================================

function safeParseJson_(text) {
  try {
    return JSON.parse(text);
  } catch (e) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (_) { return null; }
    }
    return null;
  }
}

// ============================================================
// TRIGGER SETUP / TEARDOWN
// ============================================================

/**
 * Install all triggers used by v2: hourly cleanAndLabel_ + twice-daily report.
 * Safe to run multiple times - removes old triggers for these handlers first.
 */
function installTriggers() {
  removeAllTriggers();
  ScriptApp.newTrigger('cleanAndLabel_').timeBased().everyHours(1).create();
  ScriptApp.newTrigger('generateReport_').timeBased().atHour(7).everyDays(1).inTimezone(CONFIG.TZ).create();
  ScriptApp.newTrigger('generateReport_').timeBased().atHour(19).everyDays(1).inTimezone(CONFIG.TZ).create();
  Logger.log('Triggers installed: cleanAndLabel hourly + generateReport at 07/19h BRT.');
}

function removeAllTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(t => ScriptApp.deleteTrigger(t));
  Logger.log(`Removed ${triggers.length} trigger(s).`);
}

/**
 * One-time setup: stores OAuth credentials. Caller must populate
 * OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET and per-account REFRESH_TOKEN_*
 * via ScriptProperties UI before invoking.
 */
function setupCredentials() {
  const required = ['GEMINI_API_KEY', 'ACCOUNTS_CONFIG', 'OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET'];
  const missing = required.filter(k => !PropertiesService.getScriptProperties().getProperty(k));
  if (missing.length) {
    throw new Error(`Missing required ScriptProperties: ${missing.join(', ')}`);
  }
  for (const acct of CONFIG.ACCOUNTS) {
    if (!PropertiesService.getScriptProperties().getProperty(acct.tokenKey)) {
      Logger.log(`WARN: ${acct.tokenKey} not set (account ${acct.name} will be skipped).`);
    }
  }
  Logger.log('Credentials present. Run installTriggers() next.');
}
