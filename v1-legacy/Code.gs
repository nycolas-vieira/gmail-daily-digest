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
  WEB_APP_URL: PropertiesService.getScriptProperties().getProperty('WEB_APP_URL'),
  DELETE_TOKEN: PropertiesService.getScriptProperties().getProperty('DELETE_TOKEN'),
  MAX_BODY_CHARS: 800,
  MAX_NEWSLETTER_BODY_CHARS: 4500,
  MAX_EMAILS_PER_BATCH: 50,

  // Senders that use List-Unsubscribe but are transactional (NOT newsletters)
  NEWSLETTER_DENYLIST: [
    'noreply@github.com',
    'notifications@github.com',
    'billing@service.example',
    'security@service.example',
    'noreply@service.example',
    'noreply@provider.example',
    'noreply@accounts.example',
    'security@social.example',
    '@itau.com.br',
    '@santander.com.br',
    '@bradesco.com.br',
    '@nubank.com.br',
    '@mercadopago.com',
    '@paypal.com',
    '@stripe.com',
    '@aws.amazon.com',
  ],

  // ACCOUNTS_CONFIG format in Script Properties: "name:email,name:email,..."
  // Token key is derived as REFRESH_TOKEN_{NAME_UPPER}
  ACCOUNTS: (PropertiesService.getScriptProperties().getProperty('ACCOUNTS_CONFIG') || '').split(',').filter(Boolean).map(entry => {
    const [name, email] = entry.trim().split(':');
    return { name: name, email: email, tokenKey: `REFRESH_TOKEN_${name.toUpperCase()}` };
  }),

  BLACKLIST: (PropertiesService.getScriptProperties().getProperty('BLACK_LIST') || '').split(',').filter(Boolean),

  EXCLUDED_CATEGORIES: (PropertiesService.getScriptProperties().getProperty('EXCLUDED_CATEGORIES') || '').split(',').filter(Boolean),
};

// ============================================================
// FUNCAO PRINCIPAL - Executar diariamente
// ============================================================

function dailyEmailDigest() {
  const props = PropertiesService.getScriptProperties();
  const allEmails = [];
  const accountErrors = [];
  const accountStats = [];

  Logger.log(`Contas configuradas: ${CONFIG.ACCOUNTS.length} - ${CONFIG.ACCOUNTS.map(a => a.name).join(', ')}`);
  Logger.log(`Blacklist: ${CONFIG.BLACKLIST.join(', ') || '(vazia)'}`);
  Logger.log(`Excluded categories: ${CONFIG.EXCLUDED_CATEGORIES.join(', ') || '(nenhuma)'}`);

  for (const account of CONFIG.ACCOUNTS) {
    try {
      Logger.log(`--- Processando: ${account.email} ---`);

      const refreshToken = props.getProperty(account.tokenKey);
      if (!refreshToken) {
        Logger.log(`Sem refresh token para ${account.name}, pulando.`);
        accountErrors.push({ name: account.name, email: account.email, error: 'Sem refresh token configurado' });
        continue;
      }

      const accessToken = getAccessToken_(refreshToken);
      const emails = fetchYesterdayEmails_(accessToken);
      Logger.log(`Emails encontrados (${account.name}): ${emails.length}`);

      // Sanity check: if 0 emails, probe profile to confirm token actually works
      let healthy = true;
      let healthNote = null;
      if (emails.length === 0) {
        try {
          const profile = probeAccountProfile_(accessToken);
          healthNote = `caixa ativa (${profile.totalMessages} mensagens totais)`;
        } catch (probeErr) {
          healthy = false;
          healthNote = `probe falhou: ${probeErr.message}`;
          accountErrors.push({ name: account.name, email: account.email, error: `0 emails + ${healthNote}` });
        }
      }

      // Marcar cada email com a conta de origem
      emails.forEach(e => { e.account = account.name; e.accountEmail = account.email; });
      allEmails.push(...emails);
      accountStats.push({ name: account.name, email: account.email, count: emails.length, healthy: healthy, note: healthNote });
    } catch (err) {
      Logger.log(`ERRO em ${account.name}: ${err.message}`);
      accountErrors.push({ name: account.name, email: account.email, error: err.message });
    }
  }

  Logger.log(`Total de emails de todas as contas: ${allEmails.length}`);

  if (allEmails.length === 0 && accountErrors.length === 0) {
    sendNoEmailsNotification_();
    return;
  }

  if (allEmails.length === 0 && accountErrors.length > 0) {
    sendErrorOnlyNotification_(accountErrors);
    return;
  }

  // Dedupe cross-account duplicates (same sender + subject across personal/moonxi/etc)
  const deduped = dedupeEmails_(allEmails);
  Logger.log(`Emails apos dedupe: ${deduped.length} (removidos ${allEmails.length - deduped.length})`);

  // Split into newsletters vs general mailbox
  const newsletters = deduped.filter(e => isNewsletter_(e));
  const general = deduped.filter(e => !isNewsletter_(e));
  Logger.log(`Newsletters: ${newsletters.length} | Geral: ${general.length}`);

  // Email A: Caixa de Entrada (general)
  if (general.length > 0) {
    try {
      const geminiResponse = categorizeWithGemini_(general);
      sendGeneralDigest_(geminiResponse, general.length, general, accountErrors, accountStats);
      Logger.log('Digest geral enviado.');
    } catch (err) {
      Logger.log(`ERRO digest geral: ${err.message}`);
    }
  } else {
    Logger.log('Nenhum email geral (nao-newsletter). Pulando digest geral.');
  }

  // Email B: Newsletter Digest
  if (newsletters.length > 0) {
    try {
      const newsletterResponse = categorizeNewslettersWithGemini_(newsletters);
      sendNewsletterDigest_(newsletterResponse, newsletters);
      Logger.log('Newsletter digest enviado.');
    } catch (err) {
      Logger.log(`ERRO newsletter digest: ${err.message}`);
    }
  } else {
    Logger.log('Nenhuma newsletter. Pulando newsletter digest.');
  }
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
  if (CONFIG.EXCLUDED_CATEGORIES.length > 0) {
    Logger.log(`Excluded categories: ${CONFIG.EXCLUDED_CATEGORIES.join(', ')}`);
    CONFIG.EXCLUDED_CATEGORIES.forEach(cat => {
      query += ` -${cat}`;
    });
  }

  Logger.log(`Query: ${query}`);

  // Listar mensagens (com paginacao)
  let messageIds = [];
  let pageToken = null;

  do {
    let listUrl = `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=${CONFIG.MAX_EMAILS_PER_BATCH}`;
    if (pageToken) listUrl += `&pageToken=${pageToken}`;

    const listResponse = UrlFetchApp.fetch(listUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
      muteHttpExceptions: true,
    });

    const listJson = JSON.parse(listResponse.getContentText());
    if (listJson.error) {
      throw new Error(`Gmail API list error: ${listJson.error.message}`);
    }

    const ids = (listJson.messages || []).map(m => m.id);
    messageIds.push(...ids);
    pageToken = listJson.nextPageToken || null;
  } while (pageToken && messageIds.length < 150);

  Logger.log(`Total message IDs found: ${messageIds.length}`);
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

    const bodies = extractBodies_(msg.payload);
    const plainBody = bodies.plain || stripHtmlBasic_(bodies.html);

    emails.push({
      id: msg.threadId || msg.id,
      messageId: msg.id,
      from: from,
      to: getHeader('To'),
      subject: getHeader('Subject') || '(sem assunto)',
      snippet: plainBody.substring(0, CONFIG.MAX_BODY_CHARS).replace(/\n{3,}/g, '\n\n'),
      // Retain cleaned long body for newsletter summarization (skip if this email ends up in the general bucket)
      longSnippet: cleanNewsletterHtml_(bodies.html || plainBody).substring(0, CONFIG.MAX_NEWSLETTER_BODY_CHARS),
      hasListUnsubscribe: !!getHeader('List-Unsubscribe'),
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
   - IMPORTANTE: Emails que precisam de acao ou atencao imediata (financeiro pessoal como boletos/faturas/cobranças, trabalho urgente, respostas necessarias, alertas de seguranca, disputas/contestacoes)
   - INTERESSANTE: Emails que valem a pena ler depois (newsletters de tecnologia/negocios com conteudo original, updates relevantes de projetos, convites para eventos)
   - NAO_RELEVANTE: Emails informativos que nao precisam de acao (confirmacoes automaticas, notificacoes de rotina do GitHub CI/CD, recapitulacoes de reunioes ja feitas)
   - PARA_APAGAR: Emails claramente descartaveis. Seja AGRESSIVO nesta categoria. Exemplos: propagandas e promocoes de lojas (Natura, Uber, AliExpress, etc), emails de marketing com emojis chamativos no assunto, ofertas de desconto/cupom, spam sutil de servicos que o usuario nao solicitou, newsletters genericas de plataformas (Dribbble, Fever, redes sociais), notificacoes do Facebook/Instagram sobre amigos, emails repetidos de "acordo digital" ou renegociacao de divida

REGRA CRITICA: Pelo menos 20-30% dos emails devem ser PARA_APAGAR. Se voce categorizou 0 emails como PARA_APAGAR, revise - emails de marketing e promocoes SEMPRE devem ser PARA_APAGAR. Na duvida entre NAO_RELEVANTE e PARA_APAGAR, prefira PARA_APAGAR.

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
// CHAMAR GEMINI PARA RESUMIR NEWSLETTERS (TESE + TAKEAWAYS)
// ============================================================

function categorizeNewslettersWithGemini_(emails) {
  const emailSummaries = emails.map((e, i) => {
    const dupeInfo = (e.duplicateAccounts && e.duplicateAccounts.length > 1)
      ? ` [recebido em ${e.duplicateAccounts.length} contas: ${e.duplicateAccounts.join(', ')}]`
      : '';
    return `[Newsletter ${i + 1}]
Fonte (remetente): ${e.from}
Assunto: ${e.subject}
Conta: ${e.account}${dupeInfo}
Conteudo extraido (HTML limpo):
${e.longSnippet || e.snippet}
---`;
  }).join('\n\n');

  const accounts = [...new Set(emails.map(e => `${e.account} (${e.accountEmail})`))];

  const prompt = `Voce e um assistente que resume newsletters para uma pessoa ocupada. Seu objetivo e dar contexto suficiente para decidir "ler depois vs. ignorar" SEM abrir o email.

CONTAS: ${accounts.join(', ')}
TOTAL DE NEWSLETTERS: ${emails.length}

INSTRUCOES CRITICAS:
1. Para CADA newsletter, extraia a TESE CENTRAL (o argumento principal ou noticia principal) em 1-2 frases. NAO escreva "Newsletter sobre X" ou "Newsletter da empresa Y sobre Z". Escreva a tese COMO SE fosse manchete de jornal, mencionando produtos/empresas/dados por nome.
   - EXEMPLO RUIM: "Newsletter da Every sobre design do Claude."
   - EXEMPLO BOM: "Every argumenta que a UI do Claude prioriza engenheiros em detrimento de designers, apesar do hype sobre ferramentas de design AI."

2. Liste 3 takeaways concretos (bullets curtos, especificos). Mencione numeros, nomes de produtos, empresas, pessoas. Se a newsletter tem multiplos artigos/secoes, cite cada um.

3. Identifique o tema: AI_TECH, NEGOCIOS, EVENTOS, DESENVOLVIMENTO, LIFESTYLE, OUTRO

4. Score de interesse (1-5) para um desenvolvedor empreendedor focado em AI/produto:
   - 5 = leitura obrigatoria (novo modelo, pesquisa relevante, decisao de industria)
   - 3 = interessante se tiver tempo
   - 1 = pular (promocao pura, generico)

5. No topo, escreva DESTAQUES DO DIA (2-3 frases) com os temas mais relevantes que aparecem em MULTIPLAS newsletters, se houver convergencia. Se nao houver, destaque as 2-3 newsletters de maior interesse.

FORMATO JSON:
{
  "destaques_do_dia": "texto com temas cruzados ou top newsletters do dia",
  "estatisticas": {
    "total": numero,
    "por_tema": {"AI_TECH": numero, "NEGOCIOS": numero, "EVENTOS": numero, "DESENVOLVIMENTO": numero, "LIFESTYLE": numero, "OUTRO": numero}
  },
  "newsletters": [
    {
      "numero": 1,
      "conta": "nome_da_conta",
      "fonte": "marca/autor legivel (ex: Every, Filipe Deschamps, Supabase)",
      "tema": "AI_TECH|NEGOCIOS|EVENTOS|DESENVOLVIMENTO|LIFESTYLE|OUTRO",
      "assunto": "assunto original",
      "tese": "frase unica com a tese central (manchete-estilo)",
      "takeaways": ["bullet 1", "bullet 2", "bullet 3"],
      "interesse": 1
    }
  ]
}

NEWSLETTERS:
${emailSummaries}

Responda APENAS com o JSON, sem markdown ou texto adicional.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${CONFIG.GEMINI_MODEL}:generateContent?key=${CONFIG.GEMINI_API_KEY}`;

  const payload = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 16384,
      responseMimeType: 'application/json',
    }
  };

  const response = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const json = JSON.parse(response.getContentText());
  if (json.error) throw new Error(`Gemini API error (newsletters): ${json.error.message}`);

  const text = json.candidates[0].content.parts[0].text;
  try {
    return JSON.parse(text);
  } catch (e) {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) return JSON.parse(jsonMatch[0]);
    throw new Error('Falha ao parsear resposta do Gemini (newsletters)');
  }
}

// ============================================================
// ENVIAR EMAIL COM DIGEST HTML
// ============================================================

function sendGeneralDigest_(data, totalRaw, rawEmails, accountErrors, accountStats) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = Utilities.formatDate(yesterday, Session.getScriptTimeZone(), 'dd/MM/yyyy');

  const errorSuffix = accountErrors && accountErrors.length > 0 ? ` | ${accountErrors.length} conta(s) com erro` : '';
  const subject = `[Digest] ${dateStr} | ${data.estatisticas.importantes || 0} importantes${errorSuffix}`;

  const html = buildHtmlEmail_(data, dateStr, totalRaw, rawEmails, accountErrors, accountStats);

  GmailApp.sendEmail(CONFIG.SUMMARY_RECIPIENT, subject, '', {
    htmlBody: html,
    name: 'Email Digest',
  });
}

function sendErrorOnlyNotification_(accountErrors) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = Utilities.formatDate(yesterday, Session.getScriptTimeZone(), 'dd/MM/yyyy');

  const errorList = accountErrors.map(e =>
    `<li><strong>${escapeHtml_(e.name)}</strong> (${escapeHtml_(e.email)}): ${escapeHtml_(e.error)}</li>`
  ).join('');

  GmailApp.sendEmail(
    CONFIG.SUMMARY_RECIPIENT,
    `[Digest] ${dateStr} | FALHA - ${accountErrors.length} conta(s) com erro`,
    '',
    {
      htmlBody: `<div style="font-family: sans-serif; padding: 20px;">
        <h2>Daily Email Digest - Falha</h2>
        <p>Nenhum email processado em ${dateStr}. Todas as contas falharam:</p>
        <ul>${errorList}</ul>
        <p style="color: #c5221f; font-weight: bold;">Verifique os refresh tokens no Script Properties.</p>
      </div>`,
      name: 'Email Digest',
    }
  );
}

// ============================================================
// NEWSLETTER DIGEST - EMAIL B
// ============================================================

function sendNewsletterDigest_(data, rawEmails) {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const dateStr = Utilities.formatDate(yesterday, Session.getScriptTimeZone(), 'dd/MM/yyyy');

  const total = (data.newsletters || []).length;
  const subject = `[Newsletter Digest] ${dateStr} | ${total} newsletters resumidas`;

  const html = buildNewsletterHtmlEmail_(data, dateStr, rawEmails);

  GmailApp.sendEmail(CONFIG.SUMMARY_RECIPIENT, subject, '', {
    htmlBody: html,
    name: 'Newsletter Digest',
  });
}

function buildNewsletterHtmlEmail_(data, dateStr, rawEmails) {
  const newsletters = data.newsletters || [];
  const stats = data.estatisticas || {};
  const porTema = stats.por_tema || {};

  // Map numero to raw email for Gmail links + delete buttons
  const rawMap = {};
  rawEmails.forEach((e, i) => { rawMap[i + 1] = { ...e }; });

  // Theme display config
  const themeConfig = {
    AI_TECH: { label: 'AI & Tech', color: '#6750a4' },
    DESENVOLVIMENTO: { label: 'Desenvolvimento', color: '#1a73e8' },
    NEGOCIOS: { label: 'Neg\u00f3cios', color: '#137333' },
    EVENTOS: { label: 'Eventos', color: '#e37400' },
    LIFESTYLE: { label: 'Lifestyle', color: '#c5221f' },
    OUTRO: { label: 'Outros', color: '#80868b' },
  };

  // Order themes by count desc, then by display order
  const themeOrder = ['AI_TECH', 'DESENVOLVIMENTO', 'NEGOCIOS', 'EVENTOS', 'LIFESTYLE', 'OUTRO'];
  const themeSections = themeOrder
    .map(k => ({ key: k, items: newsletters.filter(n => n.tema === k) }))
    .filter(g => g.items.length > 0);

  // Sort each group by interesse desc
  themeSections.forEach(g => g.items.sort((a, b) => (b.interesse || 0) - (a.interesse || 0)));

  const statsChips = themeOrder
    .filter(k => (porTema[k] || 0) > 0)
    .map(k => `<span style="display:inline-block;background:${themeConfig[k].color};color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;margin:2px 4px;font-weight:500;">${themeConfig[k].label}: ${porTema[k]}</span>`)
    .join('');

  const sectionsHtml = themeSections.map(g => buildNewsletterSection_(g.key, themeConfig[g.key], g.items, rawMap)).join('');

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: Georgia, 'Times New Roman', serif; background: #faf9f6; margin: 0; padding: 20px; color: #1d1d1f; }
  .container { max-width: 720px; margin: 0 auto; background: #fff; border: 1px solid #e5e5e5; word-wrap: break-word; overflow-wrap: break-word; }
  .header { padding: 32px 28px 20px 28px; border-bottom: 1px solid #e5e5e5; }
  .header h1 { margin: 0 0 6px 0; font-size: 26px; font-weight: 700; letter-spacing: -0.5px; font-family: -apple-system, BlinkMacSystemFont, sans-serif; }
  .header .subtitle { font-size: 13px; color: #6e6e73; font-family: -apple-system, sans-serif; letter-spacing: 0.5px; text-transform: uppercase; }
  .highlights { padding: 20px 28px; background: #f5f2ea; border-bottom: 1px solid #e5e5e5; }
  .highlights .label { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: #6e6e73; font-family: -apple-system, sans-serif; margin-bottom: 8px; }
  .highlights p { margin: 0; font-size: 16px; line-height: 1.55; color: #1d1d1f; }
  .themes-bar { padding: 14px 28px; background: #fff; border-bottom: 1px solid #e5e5e5; font-family: -apple-system, sans-serif; }
  .section { padding: 24px 28px; border-bottom: 1px solid #e5e5e5; }
  .section:last-of-type { border-bottom: none; }
  .section-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.2px; margin: 0 0 18px 0; padding-bottom: 6px; border-bottom: 2px solid; font-family: -apple-system, sans-serif; }
  .news-item { padding: 18px 0; border-top: 1px solid #f0ede6; }
  .news-item:first-child { border-top: none; padding-top: 0; }
  .news-item:last-child { padding-bottom: 0; }
  .news-meta { font-size: 11px; color: #8e8e93; font-family: -apple-system, sans-serif; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .news-meta .source { font-weight: 600; color: #1d1d1f; }
  .news-meta .dot { margin: 0 6px; }
  .news-meta .interesse { background: #1d1d1f; color: #fff; padding: 1px 6px; border-radius: 3px; margin-left: 6px; font-size: 10px; }
  .news-subject { font-size: 13px; color: #6e6e73; font-style: italic; margin-bottom: 8px; font-family: -apple-system, sans-serif; }
  .news-thesis { font-size: 17px; font-weight: 500; line-height: 1.45; margin: 0 0 10px 0; color: #1d1d1f; word-wrap: break-word; }
  .news-thesis a { color: #1d1d1f; text-decoration: none; border-bottom: 1px solid #1d1d1f; }
  .news-takeaways { margin: 8px 0 0 0; padding: 0 0 0 18px; font-size: 14px; line-height: 1.55; color: #3d3d3f; font-family: -apple-system, sans-serif; }
  .news-takeaways li { margin-bottom: 4px; }
  .news-actions { margin-top: 10px; font-family: -apple-system, sans-serif; }
  .btn-delete { display: inline-block; font-size: 11px; font-weight: 500; color: #8e8e93; background: transparent; border: 1px solid #d1d1d6; padding: 3px 10px; border-radius: 4px; text-decoration: none; margin-right: 6px; }
  .btn-delete:hover { background: #f5f5f7; color: #1d1d1f; }
  .footer { padding: 20px 28px; background: #f5f2ea; text-align: center; font-size: 11px; color: #8e8e93; font-family: -apple-system, sans-serif; }
  .dupe-badge { display: inline-block; font-size: 10px; background: #f0ede6; color: #6e6e73; padding: 1px 6px; border-radius: 3px; margin-left: 6px; }
</style>
</head>
<body>
<div class="container">
  <div class="header">
    <h1>Newsletter Digest</h1>
    <div class="subtitle">${dateStr} &middot; ${newsletters.length} newsletters</div>
  </div>

  <div class="highlights">
    <div class="label">Destaques do dia</div>
    <p>${escapeHtml_(data.destaques_do_dia || 'Nenhum destaque cruzado detectado. Veja as newsletters abaixo.')}</p>
  </div>

  ${statsChips ? `<div class="themes-bar">${statsChips}</div>` : ''}

  ${sectionsHtml}

  <div class="footer">
    Gerado por Gmail Digest + Gemini AI &middot; Fontes com tese e takeaways extraidos automaticamente
  </div>
</div>
</body>
</html>`;
}

function buildNewsletterSection_(themeKey, themeConf, items, rawMap) {
  const webAppUrl = CONFIG.WEB_APP_URL;
  const deleteToken = CONFIG.DELETE_TOKEN || '';

  const itemsHtml = items.map(n => {
    const raw = rawMap[n.numero] || {};
    const gmailLink = raw.id && raw.accountEmail
      ? `https://mail.google.com/mail/u/?authuser=${raw.accountEmail}#inbox/${raw.id}`
      : '';

    const takeawaysHtml = (n.takeaways || []).map(t => `<li>${escapeHtml_(t)}</li>`).join('');

    const deleteBtn = (webAppUrl && raw.messageId && raw.account)
      ? `<a href="${webAppUrl}?action=delete&account=${encodeURIComponent(raw.account)}&ids=${encodeURIComponent(raw.messageId)}&token=${encodeURIComponent(deleteToken)}" class="btn-delete">Apagar</a>`
      : '';

    const theseHtml = gmailLink
      ? `<a href="${gmailLink}">${escapeHtml_(n.tese || '')}</a>`
      : escapeHtml_(n.tese || '');

    const interesseBadge = n.interesse ? `<span class="interesse">${n.interesse}/5</span>` : '';

    const dupeBadge = (raw.duplicateAccounts && raw.duplicateAccounts.length > 1)
      ? `<span class="dupe-badge">${raw.duplicateAccounts.length} contas</span>`
      : '';

    return `
    <div class="news-item">
      <div class="news-meta">
        <span class="source">${escapeHtml_(n.fonte || '')}</span>
        <span class="dot">&middot;</span>
        <span>${escapeHtml_(n.conta || '')}</span>
        ${dupeBadge}
        ${interesseBadge}
      </div>
      <div class="news-subject">${escapeHtml_(n.assunto || '')}</div>
      <div class="news-thesis">${theseHtml}</div>
      ${takeawaysHtml ? `<ul class="news-takeaways">${takeawaysHtml}</ul>` : ''}
      <div class="news-actions">${deleteBtn}</div>
    </div>`;
  }).join('');

  return `
  <div class="section">
    <div class="section-title" style="color:${themeConf.color};border-color:${themeConf.color};">${themeConf.label}</div>
    ${itemsHtml}
  </div>`;
}

function buildHtmlEmail_(data, dateStr, totalRaw, rawEmails, accountErrors, accountStats) {
  const stats = data.estatisticas || {};
  const emails = data.emails || [];

  // Mapear numero do email -> dados originais (para link do Gmail e exclusao)
  const rawMap = {};
  rawEmails.forEach((e, i) => {
    rawMap[i + 1] = { ...e };
  });

  const importantes = emails.filter(e => e.categoria === 'IMPORTANTE');
  const interessantes = emails.filter(e => e.categoria === 'INTERESSANTE');
  const naoRelevantes = emails.filter(e => e.categoria === 'NAO_RELEVANTE');
  const paraApagar = emails.filter(e => e.categoria === 'PARA_APAGAR');

  // Build account status banner
  let accountBannerHtml = '';
  if ((accountErrors && accountErrors.length > 0) || (accountStats && accountStats.length > 0)) {
    let bannerItems = '';
    if (accountStats && accountStats.length > 0) {
      bannerItems += accountStats.map(s => {
        const isZeroWithProbe = s.count === 0 && s.healthy;
        const noteSuffix = s.note ? ` (${escapeHtml_(s.note)})` : '';
        const bg = isZeroWithProbe ? '#fff3e0' : '#e6f4ea';
        const color = isZeroWithProbe ? '#e37400' : '#137333';
        const icon = isZeroWithProbe ? '&#9888;' : '&#10003;';
        return `<span style="display:inline-block;background:${bg};color:${color};padding:2px 10px;border-radius:12px;font-size:12px;margin:2px 4px;">${icon} ${escapeHtml_(s.name)}: ${s.count} emails${noteSuffix}</span>`;
      }).join('');
    }
    if (accountErrors && accountErrors.length > 0) {
      bannerItems += accountErrors.map(e =>
        `<span style="display:inline-block;background:#fce8e6;color:#c5221f;padding:2px 10px;border-radius:12px;font-size:12px;margin:2px 4px;">&#10007; ${escapeHtml_(e.name)}: ${escapeHtml_(e.error)}</span>`
      ).join('');
    }
    accountBannerHtml = `<div style="padding:12px 16px;background:#fff3e0;border-bottom:1px solid #e8eaed;font-size:13px;"><strong>Status das contas:</strong><br>${bannerItems}</div>`;
  }

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
  .btn-delete { display: inline-block; font-size: 12px; font-weight: 500; color: #c5221f; background: #fce8e6; border: 1px solid #f5c6cb; padding: 4px 12px; border-radius: 6px; text-decoration: none; margin-top: 6px; }
  .btn-delete:hover { background: #f8d7da; }
  .btn-delete-all { display: inline-block; font-size: 13px; font-weight: 600; color: #fff; background: #c5221f; padding: 8px 20px; border-radius: 8px; text-decoration: none; margin-left: auto; }
  .btn-delete-all:hover { background: #a31b18; }
  .section-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 2px solid; }
  .section-header.important { border-color: #c5221f; }
  .section-header.interesting { border-color: #1a73e8; }
  .section-header.irrelevant { border-color: #dadce0; }
  .section-header.delete { border-color: #e37400; }
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

  ${accountBannerHtml}

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
    Use os bot\u00f5es "Apagar" para mover emails para a lixeira.
  </div>
</div>
</body>
</html>`;
}

function buildSection_(title, cssClass, emails, rawMap) {
  const webAppUrl = CONFIG.WEB_APP_URL;

  if (!emails || emails.length === 0) {
    return `
    <div class="section">
      <h3 class="section-title ${cssClass}">${title}</h3>
      <div class="empty">Nenhum email nesta categoria</div>
    </div>`;
  }

  // Build "delete all" link for the section (group by account)
  let deleteAllHtml = '';
  if (webAppUrl) {
    const byAccount = {};
    emails.forEach(e => {
      const raw = rawMap[e.numero] || {};
      if (raw.messageId && raw.account) {
        if (!byAccount[raw.account]) byAccount[raw.account] = [];
        byAccount[raw.account].push(raw.messageId);
      }
    });

    const deleteToken = CONFIG.DELETE_TOKEN || '';
    const deleteAllLinks = Object.entries(byAccount).map(([account, msgIds]) => {
      const url = `${webAppUrl}?action=delete&account=${encodeURIComponent(account)}&ids=${encodeURIComponent(msgIds.join(','))}&token=${encodeURIComponent(deleteToken)}`;
      return `<a href="${url}" class="btn-delete-all" title="Apagar todos de ${account}">Apagar todos (${msgIds.length})</a>`;
    });
    deleteAllHtml = deleteAllLinks.join(' ');
  }

  const items = emails.map(e => {
    const raw = rawMap[e.numero] || {};
    const gmailLink = raw.id && raw.accountEmail
      ? `https://mail.google.com/mail/u/?authuser=${raw.accountEmail}#inbox/${raw.id}`
      : '';
    const subjectHtml = gmailLink
      ? `<a href="${gmailLink}">${escapeHtml_(e.assunto || '')}</a>`
      : escapeHtml_(e.assunto || '');

    let deleteBtnHtml = '';
    if (webAppUrl && raw.messageId && raw.account) {
      const deleteToken = CONFIG.DELETE_TOKEN || '';
      const deleteUrl = `${webAppUrl}?action=delete&account=${encodeURIComponent(raw.account)}&ids=${encodeURIComponent(raw.messageId)}&token=${encodeURIComponent(deleteToken)}`;
      deleteBtnHtml = `<a href="${deleteUrl}" class="btn-delete">Apagar</a>`;
    }

    return `
    <div class="email-item">
      <span class="email-account">${escapeHtml_(e.conta || '')}</span>
      <div class="email-from">De: ${escapeHtml_(e.de || '')}</div>
      <div class="email-subject">${subjectHtml}</div>
      <div class="email-summary">${escapeHtml_(e.resumo || '')}</div>
      <div class="email-reason">${escapeHtml_(e.motivo || '')}</div>
      ${deleteBtnHtml}
    </div>`;
  }).join('');

  return `
  <div class="section">
    <div class="section-header ${cssClass}">
      <span style="font-size:16px;font-weight:600;">${title}</span>
      ${deleteAllHtml}
    </div>
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
    .atHour(7)
    .inTimezone('America/Sao_Paulo')
    .create();

  Logger.log('Trigger diario criado: dailyEmailDigest as 7h (America/Sao_Paulo)');
}

function removeTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  triggers.forEach(trigger => {
    ScriptApp.deleteTrigger(trigger);
  });
  Logger.log('Todos os triggers removidos.');
}

// ============================================================
// WEB APP - Endpoint para excluir emails via botao no digest
// ============================================================

function doGet(e) {
  const params = e.parameter || {};
  const action = params.action;
  const ids = params.ids ? params.ids.split(',') : [];
  const account = params.account || '';
  const token = params.token || '';
  const confirmed = params.confirmed === 'true';

  // Validate token
  if (!token || token !== CONFIG.DELETE_TOKEN) {
    return HtmlService.createHtmlOutput(buildResultPage_('Acesso negado', 'Token invalido ou ausente.', false));
  }

  if (action !== 'delete' || ids.length === 0 || !account) {
    return HtmlService.createHtmlOutput(buildResultPage_('Erro', 'Parametros invalidos.', false));
  }

  const accountConfig = CONFIG.ACCOUNTS.find(a => a.name === account);
  if (!accountConfig) {
    return HtmlService.createHtmlOutput(buildResultPage_('Erro', `Conta "${account}" nao encontrada.`, false));
  }

  // Show confirmation page if not yet confirmed
  if (!confirmed) {
    return HtmlService.createHtmlOutput(buildConfirmPage_(ids.length, account, params));
  }

  // Execute deletion
  const props = PropertiesService.getScriptProperties();
  const refreshToken = props.getProperty(accountConfig.tokenKey);
  if (!refreshToken) {
    return HtmlService.createHtmlOutput(buildResultPage_('Erro', `Sem token para conta "${account}".`, false));
  }

  try {
    const accessToken = getAccessToken_(refreshToken);
    let deleted = 0;

    for (const msgId of ids) {
      const url = `https://gmail.googleapis.com/gmail/v1/users/me/messages/${msgId}/trash`;
      const resp = UrlFetchApp.fetch(url, {
        method: 'post',
        headers: { Authorization: `Bearer ${accessToken}` },
        muteHttpExceptions: true,
      });
      const result = JSON.parse(resp.getContentText());
      if (!result.error) deleted++;
    }

    const msg = deleted === 1
      ? '1 email movido para a lixeira.'
      : `${deleted} emails movidos para a lixeira.`;
    return HtmlService.createHtmlOutput(buildResultPage_('Sucesso', msg, true));
  } catch (err) {
    return HtmlService.createHtmlOutput(buildResultPage_('Erro', `Falha ao excluir: ${err.message}`, false));
  }
}

function buildConfirmPage_(count, account, params) {
  const confirmUrl = `${CONFIG.WEB_APP_URL}?action=${encodeURIComponent(params.action)}&account=${encodeURIComponent(params.account)}&ids=${encodeURIComponent(params.ids)}&token=${encodeURIComponent(params.token)}&confirmed=true`;
  const label = count === 1 ? '1 email' : `${count} emails`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5;}
.card{text-align:center;background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);max-width:420px;}
.icon{font-size:48px;margin-bottom:16px;}
h1{font-size:20px;color:#333;margin:0 0 8px 0;}
p{font-size:14px;color:#666;margin:0 0 24px 0;}
.btn{display:inline-block;padding:12px 28px;border-radius:8px;text-decoration:none;font-size:14px;font-weight:600;margin:0 8px;}
.btn-confirm{background:#c5221f;color:#fff;}
.btn-confirm:hover{background:#a31b18;}
.btn-cancel{background:#f1f3f4;color:#333;}
.btn-cancel:hover{background:#e0e0e0;}
</style>
</head><body><div class="card">
<div class="icon">&#9888;</div>
<h1>Confirmar exclusao</h1>
<p>Mover <strong>${label}</strong> da conta <strong>${escapeHtml_(account)}</strong> para a lixeira?</p>
<a href="${confirmUrl}" class="btn btn-confirm">Confirmar</a>
<a href="javascript:window.close()" class="btn btn-cancel">Cancelar</a>
</div></body></html>`;
}

function buildResultPage_(title, message, success) {
  const color = success ? '#1a73e8' : '#c5221f';
  const icon = success ? '&#10003;' : '&#10007;';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5;}
.card{text-align:center;background:#fff;padding:40px;border-radius:12px;box-shadow:0 2px 8px rgba(0,0,0,0.1);max-width:400px;}
.icon{font-size:48px;color:${color};margin-bottom:16px;}
h1{font-size:20px;color:#333;margin:0 0 8px 0;}
p{font-size:14px;color:#666;margin:0;}</style>
</head><body><div class="card"><div class="icon">${icon}</div><h1>${title}</h1><p>${message}</p></div></body></html>`;
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
  Logger.log('  WEB_APP_URL (URL do deploy da web app)');
  Logger.log('  DELETE_TOKEN (execute generateDeleteToken para gerar)');
}

function generateDeleteToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  PropertiesService.getScriptProperties().setProperty('DELETE_TOKEN', token);
  Logger.log(`DELETE_TOKEN gerado e salvo: ${token}`);
  return token;
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

function extractBodies_(payload) {
  let plain = '';
  let html = '';

  function walk(part) {
    if (!part) return;
    if (part.mimeType === 'text/plain' && part.body && part.body.data && !plain) {
      plain = Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data)).getDataAsString();
    } else if (part.mimeType === 'text/html' && part.body && part.body.data && !html) {
      html = Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data)).getDataAsString();
    }
    if (part.parts) part.parts.forEach(walk);
  }
  walk(payload);
  return { plain: plain, html: html };
}

function stripHtmlBasic_(html) {
  if (!html) return '';
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function cleanNewsletterHtml_(input) {
  if (!input) return '';
  let s = input;

  // Drop heavy non-content blocks
  s = s.replace(/<script[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<head[\s\S]*?<\/head>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<img[^>]*>/gi, ' ');

  // Keep anchor text only, drop href
  s = s.replace(/<a\s+[^>]*>([\s\S]*?)<\/a>/gi, '$1');

  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, ' ');

  // Decode common HTML entities
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&[a-z]+;/gi, ' ')
    .replace(/&#\d+;/g, ' ');

  // Remove boilerplate lines (unsubscribe / manage preferences / viewing in browser)
  const boilerplate = [
    /unsubscribe[^.\n]*\.?/gi,
    /view (in|as) (a )?(web |email )?browser/gi,
    /click here to (view|unsubscribe|manage|read)[^.\n]*\.?/gi,
    /manage (your )?(email )?(preferences|subscriptions)[^.\n]*\.?/gi,
    /you('re| are) receiving this[^.\n]*\.?/gi,
    /this email was sent to[^.\n]*\.?/gi,
    /para cancelar[^.\n]*\.?/gi,
    /para n[ãa]o receber[^.\n]*\.?/gi,
    /cancelar inscri[çc][ãa]o[^.\n]*\.?/gi,
    /se voc[êe] n[ãa]o deseja[^.\n]*\.?/gi,
    /all rights reserved[^.\n]*\.?/gi,
    /copyright\s*©[^.\n]*\.?/gi,
  ];
  boilerplate.forEach(re => { s = s.replace(re, ' '); });

  // Collapse whitespace
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

function probeAccountProfile_(accessToken) {
  const url = 'https://gmail.googleapis.com/gmail/v1/users/me/profile';
  const resp = UrlFetchApp.fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    muteHttpExceptions: true,
  });
  const json = JSON.parse(resp.getContentText());
  if (json.error) throw new Error(json.error.message || 'profile error');
  return { email: json.emailAddress, totalMessages: json.messagesTotal || 0 };
}

function dedupeEmails_(emails) {
  const seen = new Map();
  const unique = [];
  for (const email of emails) {
    const fromMatch = email.from.match(/<([^>]+)>/);
    const fromEmail = (fromMatch ? fromMatch[1] : email.from).toLowerCase().trim();
    const subject = (email.subject || '').trim().toLowerCase();
    const key = `${fromEmail}|${subject}`;
    if (!seen.has(key)) {
      email.duplicateAccounts = [email.account];
      seen.set(key, email);
      unique.push(email);
    } else {
      const existing = seen.get(key);
      if (!existing.duplicateAccounts.includes(email.account)) {
        existing.duplicateAccounts.push(email.account);
      }
    }
  }
  return unique;
}

function isNewsletter_(email) {
  const fromLower = (email.from || '').toLowerCase();
  // Explicit deny: transactional / security senders that do use List-Unsubscribe
  if (CONFIG.NEWSLETTER_DENYLIST.some(p => fromLower.includes(p.toLowerCase()))) {
    return false;
  }

  // Primary signal: RFC 2369 List-Unsubscribe header
  if (email.hasListUnsubscribe) return true;

  // Fallback: Gmail categories for promos/updates
  const labels = email.labels || [];
  if (labels.includes('CATEGORY_PROMOTIONS') || labels.includes('CATEGORY_UPDATES')) {
    return true;
  }

  // Fallback: sender patterns that almost always mean newsletter
  const senderRegex = /(^|<)(newsletter|news|digest|hello|hi|notify|email|marketing|mkt)@|@(email|mail|newsletter|news|updates|cf|newarrival|emailmarket|mkt|mktmail|notifications|weekly)\./i;
  if (senderRegex.test(email.from)) return true;

  return false;
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

function testNewsletterClassification_() {
  // Ad-hoc: run through yesterday's emails and log newsletter vs general classification
  const props = PropertiesService.getScriptProperties();
  for (const account of CONFIG.ACCOUNTS) {
    const refreshToken = props.getProperty(account.tokenKey);
    if (!refreshToken) { Logger.log(`${account.name}: sem token`); continue; }
    const accessToken = getAccessToken_(refreshToken);
    const emails = fetchYesterdayEmails_(accessToken);
    emails.forEach(e => { e.account = account.name; e.accountEmail = account.email; });
    const deduped = dedupeEmails_(emails);
    Logger.log(`\n=== ${account.name}: ${deduped.length} (dedup de ${emails.length}) ===`);
    deduped.forEach(e => {
      Logger.log(`${isNewsletter_(e) ? '[NEWS]' : '[GER ]'} ${e.from} | ${e.subject}`);
    });
  }
}
