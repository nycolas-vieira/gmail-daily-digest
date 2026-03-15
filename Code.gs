// ============================================================
// Gmail Daily Digest com Gemini AI - Multi Account
// Roda diariamente na conta personal via Apps Script
// Busca emails de todas as contas via Gmail REST API
// Envia resumo categorizado para o destinatario configurado
// ============================================================

const CONFIG = {
  GEMINI_API_KEY: PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY'),
  GEMINI_MODEL: 'gemini-2.5-flash',
  SUMMARY_RECIPIENT: PropertiesService.getScriptProperties().getProperty('SUMMARY_RECIPIENT'),
  MAX_BODY_CHARS: 800,
  MAX_EMAILS_PER_BATCH: 50,

  // ACCOUNTS_CONFIG format in Script Properties: "name:email,name:email,..."
  // Token key is derived as REFRESH_TOKEN_{NAME_UPPER}
  ACCOUNTS: (PropertiesService.getScriptProperties().getProperty('ACCOUNTS_CONFIG') || '').split(',').filter(Boolean).map(entry => {
    const [name, email] = entry.trim().split(':');
    return { name: name, email: email, tokenKey: `REFRESH_TOKEN_${name.toUpperCase()}` };
  }),

  BLACKLIST: [],

  EXCLUDED_CATEGORIES: [],
};

// ============================================================
// FUNCAO PRINCIPAL - Executar diariamente
// ============================================================

function dailyEmailDigest() {
  const props = PropertiesService.getScriptProperties();
  const allEmails = [];

  for (const account of CONFIG.ACCOUNTS) {
    try {
      Logger.log(`--- Processando: ${account.email} ---`);

      const refreshToken = props.getProperty(account.tokenKey);
      if (!refreshToken) {
        Logger.log(`Sem refresh token para ${account.name}, pulando.`);
        continue;
      }

      const accessToken = getAccessToken_(refreshToken);
      const emails = fetchYesterdayEmails_(accessToken);
      Logger.log(`Emails encontrados (${account.name}): ${emails.length}`);

      // Marcar cada email com a conta de origem
      emails.forEach(e => { e.account = account.name; e.accountEmail = account.email; });
      allEmails.push(...emails);
    } catch (err) {
      Logger.log(`ERRO em ${account.name}: ${err.message}`);
    }
  }

  Logger.log(`Total de emails de todas as contas: ${allEmails.length}`);

  if (allEmails.length === 0) {
    sendNoEmailsNotification_();
    return;
  }

  const geminiResponse = categorizeWithGemini_(allEmails);
  sendDigestEmail_(geminiResponse, allEmails.length, allEmails);

  Logger.log('Digest unico enviado com sucesso!');
}

// ============================================================
// OAUTH - Trocar refresh token por access token
// ============================================================

function getAccessToken_(refreshToken) {
  const props = PropertiesService.getScriptProperties();
  const clientId = props.getProperty('OAUTH_CLIENT_ID');
  const clientSecret = props.getProperty('OAUTH_CLIENT_SECRET');

  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token', {
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

  const json = JSON.parse(response.getContentText());
  if (json.error) {
    throw new Error(`OAuth error: ${json.error} - ${json.error_description}`);
  }

  return json.access_token;
}

// ============================================================
// BUSCAR EMAILS DO DIA ANTERIOR VIA GMAIL REST API
// ============================================================

function fetchYesterdayEmails_(accessToken) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  yesterday.setHours(0, 0, 0, 0);

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dateAfter = formatDate_(yesterday);
  const dateBefore = formatDate_(today);

  let query = `after:${dateAfter} before:${dateBefore} -in:trash -in:spam -subject:[Digest]`;
  CONFIG.EXCLUDED_CATEGORIES.forEach(cat => {
    query += ` -${cat}`;
  });

  Logger.log(`Query: ${query}`);

  // Listar mensagens
  const listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${CONFIG.MAX_EMAILS_PER_BATCH}`;
  const listResponse = UrlFetchApp.fetch(listUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
    muteHttpExceptions: true,
  });

  const listJson = JSON.parse(listResponse.getContentText());
  if (listJson.error) {
    throw new Error(`Gmail API list error: ${listJson.error.message}`);
  }

  const messageIds = (listJson.messages || []).map(m => m.id);
  if (messageIds.length === 0) return [];

  // Buscar detalhes de cada mensagem
  const emails = [];
  for (const msgId of messageIds) {
    const msgUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}?format=full`;
    const msgResponse = UrlFetchApp.fetch(msgUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      muteHttpExceptions: true,
    });

    const msg = JSON.parse(msgResponse.getContentText());
    if (msg.error) continue;

    const headers = msg.payload.headers || [];
    const getHeader = (name) => (headers.find(h => h.name.toLowerCase() === name.toLowerCase()) || {}).value || '';

    const from = getHeader('From');
    if (isBlacklisted_(from)) continue;

    const body = getMessageBody_(msg.payload);

    emails.push({
      id: msg.threadId || msg.id,
      from: from,
      to: getHeader('To'),
      subject: getHeader('Subject') || '(sem assunto)',
      snippet: body.substring(0, CONFIG.MAX_BODY_CHARS).replace(/\n{3,}/g, '\n\n'),
      date: new Date(parseInt(msg.internalDate)).toISOString(),
      labels: msg.labelIds || [],
      isUnread: (msg.labelIds || []).includes('UNREAD'),
      isStarred: (msg.labelIds || []).includes('STARRED'),
      hasAttachments: hasAttachments_(msg.payload),
    });
  }

  return emails;
}

// ============================================================
// EXTRAIR BODY DO PAYLOAD DA GMAIL API
// ============================================================

function getMessageBody_(payload) {
  // Tentar pegar text/plain direto
  if (payload.mimeType === 'text/plain' && payload.body && payload.body.data) {
    return Utilities.newBlob(Utilities.base64DecodeWebSafe(payload.body.data)).getDataAsString();
  }

  // Buscar em parts
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data)).getDataAsString();
      }
    }
    // Se nao encontrou text/plain, tentar text/html e limpar
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        const html = Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data)).getDataAsString();
        return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      }
    }
    // Buscar recursivamente em multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const result = getMessageBody_(part);
        if (result) return result;
      }
    }
  }

  // Fallback: snippet do proprio message
  return '';
}

function hasAttachments_(payload) {
  if (payload.parts) {
    return payload.parts.some(p => p.filename && p.filename.length > 0);
  }
  return false;
}

// ============================================================
// CHAMAR GEMINI PARA CATEGORIZAR E RESUMIR
// ============================================================

function categorizeWithGemini_(emails) {
  const emailSummaries = emails.map((e, i) => {
    return `[Email ${i + 1}]
Conta: ${e.account} (${e.accountEmail})
De: ${e.from}
Assunto: ${e.subject}
Data: ${e.date}
Labels: ${(Array.isArray(e.labels) ? e.labels : []).join(', ') || 'nenhum'}
Nao lido: ${e.isUnread ? 'Sim' : 'Nao'}
Anexos: ${e.hasAttachments ? 'Sim' : 'Nao'}
Conteudo:
${e.snippet}
---`;
  }).join('\n\n');

  const accounts = [...new Set(emails.map(e => `${e.account} (${e.accountEmail})`))];

  const prompt = `Voce e um assistente pessoal que analisa emails diarios de multiplas contas.

CONTAS: ${accounts.join(', ')}
DATA: ${formatDate_(new Date(emails[0].date))} (ontem)
TOTAL DE EMAILS: ${emails.length}

INSTRUCOES:
1. Analise todos os emails abaixo (de todas as contas)
2. Crie um RESUMO GERAL do dia (2-3 frases sobre o que aconteceu nas contas)
3. Categorize CADA email em uma das 4 categorias:
   - IMPORTANTE: Emails que precisam de acao ou atencao imediata (financeiro, trabalho urgente, respostas necessarias, seguranca)
   - INTERESSANTE: Emails que valem a pena ler depois (noticias relevantes, updates de projetos, conteudo util)
   - NAO_RELEVANTE: Emails informativos que nao precisam de acao (confirmacoes automaticas, notificacoes de rotina)
   - PARA_APAGAR: Emails claramente descartaveis (propagandas que passaram do filtro, newsletters repetitivas, spam sutil)

4. Para cada email, forneca:
   - Numero do email
   - Conta de origem
   - Categoria
   - Resumo de 1 linha
   - Motivo da categorizacao (breve)

FORMATO DE RESPOSTA (use exatamente este formato JSON):
{
  "resumo_geral": "texto do resumo geral do dia",
  "estatisticas": {
    "total": numero,
    "importantes": numero,
    "interessantes": numero,
    "nao_relevantes": numero,
    "para_apagar": numero
  },
  "emails": [
    {
      "numero": 1,
      "conta": "nome_da_conta",
      "categoria": "IMPORTANTE|INTERESSANTE|NAO_RELEVANTE|PARA_APAGAR",
      "de": "remetente",
      "assunto": "assunto original",
      "resumo": "resumo de 1 linha",
      "motivo": "motivo breve"
    }
  ]
}

EMAILS:
${emailSummaries}

Responda APENAS com o JSON, sem markdown ou texto adicional.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

  const payload = {
    contents: [{
      parts: [{
        text: prompt
      }]
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 8192,
      responseMimeType: 'application/json',
    }
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const json = JSON.parse(response.getContentText());

  if (json.error) {
    Logger.log(`Erro Gemini: ${JSON.stringify(json.error)}`);
    throw new Error(`Gemini API error: ${json.error.message}`);
  }

  const text = json.candidates[0].content.parts[0].text;

  try {
    return JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    throw new Error('Falha ao parsear resposta do Gemini');
  }
}

// ============================================================
// ENVIAR EMAIL COM DIGEST HTML
// ============================================================

function sendDigestEmail_(data, totalRaw, rawEmails) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = Utilities.formatDate(yesterday, Session.getScriptTimeZone(), 'dd/MM/yyyy');

  const subject = `[Digest] ${dateStr} | ${data.estatisticas.importantes || 0} importantes`;

  const html = buildHtmlEmail_(data, dateStr, totalRaw, rawEmails);

  GmailApp.sendEmail(CONFIG.SUMMARY_RECIPIENT, subject, '', {
    htmlBody: html,
    name: 'Email Digest',
  });
}

function buildHtmlEmail_(data, dateStr, totalRaw, rawEmails) {
  const stats = data.estatisticas || {};
  const emails = data.emails || [];

  // Mapear numero do email -> dados originais (para link do Gmail)
  const rawMap = {};
  rawEmails.forEach((e, i) => {
    rawMap[i + 1] = e;
  });

  const importantes = emails.filter(e => e.categoria === 'IMPORTANTE');
  const interessantes = emails.filter(e => e.categoria === 'INTERESSANTE');
  const naoRelevantes = emails.filter(e => e.categoria === 'NAO_RELEVANTE');
  const paraApagar = emails.filter(e => e.categoria === 'PARA_APAGAR');

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f5f5; margin: 0; padding: 20px; color: #333; }
  .container { max-width: 680px; margin: 0 auto; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 8px rgba(0,0,0,0.1); word-wrap: break-word; overflow-wrap: break-word; }
  .header { background: linear-gradient(135deg, #1a73e8, #4285f4); color: #fff; padding: 24px 16px; }
  .header h1 { margin: 0 0 4px 0; font-size: 22px; font-weight: 600; }
  .header .subtitle { opacity: 0.9; font-size: 14px; }
  .summary { padding: 24px 16px; background: #f8f9fa; border-bottom: 1px solid #e8eaed; }
  .summary p { margin: 0; font-size: 15px; line-height: 1.6; color: #444; word-wrap: break-word; overflow-wrap: break-word; }
  .stats { display: flex; justify-content: space-between; gap: 8px; padding: 16px 20px; border-bottom: 1px solid #e8eaed; flex-wrap: wrap; }
  .stat { flex: 0 1 auto; min-width: 70px; text-align: center; padding: 12px 16px; border-radius: 8px; }
  .stat .num { font-size: 24px; font-weight: 700; }
  .stat .label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.3px; margin-top: 4px; }
  .stat.important { background: #fce8e6; color: #c5221f; }
  .stat.interesting { background: #e8f0fe; color: #1a73e8; }
  .stat.irrelevant { background: #f1f3f4; color: #80868b; }
  .stat.delete { background: #fef7e0; color: #e37400; }
  .section { padding: 20px 16px; }
  .section-title { font-size: 16px; font-weight: 600; margin: 0 0 16px 0; padding-bottom: 8px; border-bottom: 2px solid; display: flex; align-items: center; gap: 8px; }
  .section-title.important { color: #c5221f; border-color: #c5221f; }
  .section-title.interesting { color: #1a73e8; border-color: #1a73e8; }
  .section-title.irrelevant { color: #80868b; border-color: #dadce0; }
  .section-title.delete { color: #e37400; border-color: #e37400; }
  .email-item { padding: 12px 0; border-bottom: 1px solid #f1f3f4; }
  .email-item:last-child { border-bottom: none; }
  .email-from { font-size: 13px; color: #80868b; margin-bottom: 2px; }
  .email-account { display: inline-block; font-size: 11px; background: #e8f0fe; color: #1a73e8; padding: 1px 8px; border-radius: 10px; margin-bottom: 4px; font-weight: 500; }
  .email-subject { font-size: 14px; font-weight: 600; color: #202124; margin-bottom: 4px; word-wrap: break-word; overflow-wrap: break-word; }
  .email-subject a { color: #202124; text-decoration: none; word-wrap: break-word; overflow-wrap: break-word; }
  .email-subject a:hover { text-decoration: underline; }
  .email-summary { font-size: 13px; color: #5f6368; line-height: 1.4; word-wrap: break-word; overflow-wrap: break-word; }
  .email-reason { font-size: 12px; color: #9aa0a6; font-style: italic; margin-top: 4px; }
  .footer { padding: 20px 16px; background: #f8f9fa; text-align: center; font-size: 12px; color: #9aa0a6; border-top: 1px solid #e8eaed; }
  .empty { color: #9aa0a6; font-style: italic; padding: 8px 0; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Daily Email Digest</h1>
    <div class="subtitle">${dateStr} &bull; ${totalRaw} emails processados</div>
  </div>

  <div class="summary">
    <p>${escapeHtml_(data.resumo_geral || 'Sem resumo dispon\u00edvel.')}</p>
  </div>

  <div class="stats">
    <div class="stat important">
      <div class="num">${stats.importantes || 0}</div>
      <div class="label">Importantes</div>
    </div>
    <div class="stat interesting">
      <div class="num">${stats.interessantes || 0}</div>
      <div class="label">Interessantes</div>
    </div>
    <div class="stat irrelevant">
      <div class="num">${stats.nao_relevantes || 0}</div>
      <div class="label">Informativos</div>
    </div>
    <div class="stat delete">
      <div class="num">${stats.para_apagar || 0}</div>
      <div class="label">Para apagar</div>
    </div>
  </div>

  ${buildSection_('Importante (olhar melhor)', 'important', importantes, rawMap)}
  ${buildSection_('Interessante (ver depois)', 'interesting', interessantes, rawMap)}
  ${buildSection_('N\u00e3o relevante (informativo)', 'irrelevant', naoRelevantes, rawMap)}
  ${buildSection_('Para apagar (aguardando autoriza\u00e7\u00e3o)', 'delete', paraApagar, rawMap)}

  <div class="footer">
    Gerado automaticamente por Gmail Digest + Gemini AI<br>
    Nenhum email foi apagado. Responda este email para autorizar exclus\u00f5es.
  </div>
</div>
</body>
</html>`;
}

function buildSection_(title, cssClass, emails, rawMap) {
  if (!emails || emails.length === 0) {
    return `
    <div class="section">
      <h3 class="section-title ${cssClass}">${title}</h3>
      <div class="empty">Nenhum email nesta categoria</div>
    </div>`;
  }

  const items = emails.map(e => {
    const raw = rawMap[e.numero] || {};
    const gmailLink = raw.id && raw.accountEmail
      ? `https://mail.google.com/mail/u/?authuser=${raw.accountEmail}#inbox/${raw.id}`
      : '';
    const subjectHtml = gmailLink
      ? `<a href="${gmailLink}">${escapeHtml_(e.assunto || '')}</a>`
      : escapeHtml_(e.assunto || '');

    return `
    <div class="email-item">
      <span class="email-account">${escapeHtml_(e.conta || '')}</span>
      <div class="email-from">De: ${escapeHtml_(e.de || '')}</div>
      <div class="email-subject">${subjectHtml}</div>
      <div class="email-summary">${escapeHtml_(e.resumo || '')}</div>
      <div class="email-reason">${escapeHtml_(e.motivo || '')}</div>
    </div>`;
  }).join('');

  return `
  <div class="section">
    <h3 class="section-title ${cssClass}">${title}</h3>
    ${items}
  </div>`;
}

// ============================================================
// FUNCAO PARA EMAILS SEM MENSAGENS
// ============================================================

function sendNoEmailsNotification_() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = Utilities.formatDate(yesterday, Session.getScriptTimeZone(), 'dd/MM/yyyy');

  GmailApp.sendEmail(
    CONFIG.SUMMARY_RECIPIENT,
    `[Digest] ${dateStr} | Sem emails`,
    '',
    {
      htmlBody: `<div style="font-family: sans-serif; padding: 20px;">
        <h2>Daily Email Digest</h2>
        <p>Nenhum email encontrado em ${dateStr} em nenhuma das contas.</p>
        <p style="color: #999; font-size: 12px;">Emails de spam e lixeira foram exclu\u00eddos.</p>
      </div>`,
      name: 'Email Digest',
    }
  );
}

// ============================================================
// SETUP - Criar trigger diario
// ============================================================

function setupDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    if (trigger.getHandlerFunction() === 'dailyEmailDigest') {
      ScriptApp.deleteTrigger(trigger);
    }
  });

  ScriptApp.newTrigger('dailyEmailDigest')
    .timeBased()
    .everyDays(1)
    .atHour(8)
    .inTimezone('America/Sao_Paulo')
    .create();

  Logger.log('Trigger diario criado: dailyEmailDigest as 8h (America/Sao_Paulo)');
}

function removeTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    ScriptApp.deleteTrigger(trigger);
  });
  Logger.log('Todos os triggers removidos.');
}

// ============================================================
// SETUP - Configurar credenciais no Script Properties
// ============================================================

function setupCredentials() {
  Logger.log('Configure as credenciais manualmente em Configuracoes > Propriedades do script:');
  Logger.log('  OAUTH_CLIENT_ID, OAUTH_CLIENT_SECRET, GEMINI_API_KEY');
  Logger.log('  SUMMARY_RECIPIENT (email to receive the digest)');
  Logger.log('  ACCOUNTS_CONFIG (format: name1:email1,name2:email2,...)');
  Logger.log('  REFRESH_TOKEN_{NAME} for each account (e.g. REFRESH_TOKEN_PERSONAL)');
}

// ============================================================
// UTILITARIOS
// ============================================================

function formatDate_(date) {
  return Utilities.formatDate(date, Session.getScriptTimeZone(), 'yyyy/MM/dd');
}

function isBlacklisted_(from) {
  const fromLower = from.toLowerCase();
  return CONFIG.BLACKLIST.some(pattern => fromLower.includes(pattern.toLowerCase()));
}

function escapeHtml_(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ============================================================
// TESTE MANUAL
// ============================================================

function testDigest() {
  dailyEmailDigest();
}
