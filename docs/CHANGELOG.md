# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**:date: ORDER**: Entries are organized in **descending chronological order** (newest first).

## [3.1.0] - 2026-06-15 - entrega do report (email + Echo/Telegram), launchd e guarda de self-mail

O modo `-report` deixa de ser só um arquivo no vault: agora entrega o digest
por email e empurra pro Echo/Telegram, com a lista de senders SOFT pra promover
a HARD. Agendamento migra de cron pra launchd (recupera runs perdidos quando o
Mac dorme) rodando via Docker. Sessões: S-20260615-01..04.

### Added
- `internal/deliver`: entrega do digest por **email** (HTML, via Gmail
  `messages/send`) e **push pro Echo/Telegram** (POST pro argus-webhook
  `/gmail-organizer/<secret>` -> Firestore -> Echo). Ambos best-effort e
  opcionais: canal não configurado é pulado, falha é logada e NÃO bloqueia o
  reset do período. (S-20260615-02, S-20260615-03)
- `gmail.Send(from, to, subject, htmlBody)` (escopo `gmail.send` já concedido).
- Bloco `report` no config (`email`, `from_account`, `argus_webhook_url`,
  `argus_webhook_secret`) + overrides por env (`REPORT_EMAIL`,
  `ARGUS_WEBHOOK_URL`, `ARGUS_WEBHOOK_SECRET`) pra rodar no Docker.
- Comando `gmail-daily-digest -promote <addr>`: move um sender de SOFT pra HARD
  (auto-trash). O digest sugere candidatos (os senders que bateram em "Revisar"
  no período). (S-20260615-02)
- `internal/report.State.RevisarSenders`: rastreio dos senders SOFT do período
  pra alimentar a sugestão de promoção.
- `scripts/run-organizer.sh` + plists launchd (`scripts/launchd/`): agendamento
  via launchd rodando o organizer por Docker, apontado pro Ollama do host
  (`host.docker.internal`), com espera de rede. (S-20260615-01)
- Testes: `internal/deliver`, `internal/config/promote`, `internal/organizer`.

### Changed
- `docker-compose.yml`: `OLLAMA_ENDPOINT` agora interpola do ambiente
  (`${OLLAMA_ENDPOINT:-http://ollama:11434}`) pra um export do host vencer; e o
  `report_dir` (vault inbox) passa a ser montado no container pra o markdown não
  se perder. (S-20260615-01)
- README: seção de entrega do report, comando `-promote`, e nota de que o
  `HARD: N` do report inclui os 2 builtins (`aliexpress`, `github.com`) - não é
  perda de dados (esclarecimento da investigação S-20260615-04).

### Fixed
- Self-mail: o email de relatório é auto-enviado (personal->personal) e o
  organizer passava a classificá-lo; um modelo pequeno (gemma3:4b) chegou a
  marcá-lo como LIXO e a aprender o próprio endereço do usuário no SOFT. Guarda
  `isOwn()` no organizer: mail de qualquer conta própria nunca é
  classificado/lixado/aprendido - é rotulado PESSOAL e mantido. (S-20260615-02)

## [3.0.0] - 2026-06-06 - port para Go local + Ollama (aposenta o GAS)

Reescrita completa do runtime. O organizador sai do Google Apps Script +
Gemini e passa a ser um binário Go que roda **localmente** e classifica
com um modelo **Ollama** (`qwen2.5:7b`). Motivação: zero custo de API,
zero quota, privacidade (o conteúdo do email nunca sai da máquina) e o
fim da dependência do trial do Gemini. O repo é público, então nenhum
segredo vive no código: a config de runtime é reconstruída localmente.

### Added
- Binário Go (`main.go`) com modos: organizar (default), `-dry-run`,
  `-report` (renderiza o digest do período e reseta), `-reset`.
- `internal/config`: loader do `config.json` (falha alto, sem fallbacks) +
  blocklist de duas camadas (HARD auto-trash, SOFT label `Revisar`,
  auto-learn de LIXO para SOFT). Built-in HARD: `aliexpress`, `github.com`.
- `internal/gmail`: cliente REST enxuto (list/get/trash/modify/labels) +
  troca de refresh token por access token + strip de HTML.
- `internal/classify`: classificador Ollama com **structured outputs**
  (schema JSON fixo) e classificação **um email por vez** (principal alavanca
  de qualidade num modelo pequeno). Prompt de categorização reescrito.
- `internal/organizer`: pipeline por conta (porte de `processAccount_`).
- `internal/report`: estado de período em `state.json` local (substitui as
  ScriptProperties) + render do digest em Markdown.
- `config.example.json` e `scripts/bootstrap-config.sh`: gera o `config.json`
  git-ignored lendo o OAuth client de `~/.config/gmail-cli/credentials.json`
  e os refresh tokens dos `token.pickle` por conta.
- **Docker:** `Dockerfile` (multi-stage, binário estático + runtime distroless),
  `docker-compose.yml` (serviço `ollama` + serviço `organizer` one-shot) e
  `.dockerignore`. Nenhum segredo entra na imagem: `config.json` é bind-mount
  read-only; só o arquivo da blocklist e o data dir (state + reports) são
  graváveis. Override de env `OLLAMA_ENDPOINT`/`OLLAMA_MODEL` deixa a mesma
  `config.json` rodar dentro e fora do container.
- README reescrito para a arquitetura local Go + Ollama (+ seção Docker).
- Log por decisão no organizer (categoria + razão curta + assunto truncado),
  valendo em dry-run e run real. Essencial pra inspecionar a qualidade da
  classificação sem abrir o Gmail.

### Changed
- Categorias e rótulos consolidados: `LIXO`, `CONTAS`, `NEWSLETTER`,
  `URGENTE`, `PESSOAL`, `DOCUMENTO`, `OUTROS`. URGENTE e PESSOAL ficam na
  inbox; CONTAS/NEWSLETTER/DOCUMENTO/OUTROS são arquivados após rotular.
- `.gitignore`: ignora `config.json` e `state.json` (o `config.example.json`
  é versionado). A blocklist segue em `~/.config/gmail-cli` (fora do repo).

### Removed
- `Code.gs`, `appsscript.json`, `.clasp.json`, `.claspignore`, `v1-legacy/`.
  O runtime GAS está aposentado. O histórico permanece no git (último em
  `v2.5.1`, commit `1fef9eb`); reverter = restaurar esses arquivos e
  `clasp push`.

---

## [2.5.1] - 2026-06-04 - github zero-Gemini hard-trash

Continuacao do cost cut: o GitHub era de longe o maior volume de email
ruido (455 numa unica rodada no personal) e cada um pagava uma chamada
Gemini so pra ser classificado como LIXO. Agora github e hard-trashed por
sender, antes de qualquer chamada ao Flash-Lite. Politica definida pelo
Nyc: nenhuma notificacao do GitHub e util na inbox (ele e chamado
pessoalmente para reviews reais).

### Changed
- `HARD_TRASH_SENDERS` (built-in list): adicionado `github.com`. O
  `isHardTrash_` casa por `includes()`, entao pega `notifications@github.com`
  e `noreply@github.com`. Resultado: todo email do GitHub vai pra Lixeira
  em `processAccount_` (passo 3) ANTES de entrar no chunk do Gemini -> zero
  custo de API para github.
- Regra de GitHub no prompt do Gemini reduzida de um paragrafo para uma
  linha (rede de seguranca apenas; github normalmente nem chega ao Gemini).
  Economiza tokens de input em toda chamada.

### Fixed
- Comentario de cabecalho do `Code.gs` corrigido: `cleanAndLabel_` roda
  `07:00 e 19:00 BRT`, nao `hourly` (estava stale desde a mudanca 2.5.0).

---

## [2.5.0] - 2026-05-30 - cost cut pre end-of-trial

Free Trial expira em 10 dias e o billing report mostrou ~R$6/dia em
Gemini API (projetando R$180/mo se mantivesse hourly + Flash). Cut
agressivo pra cair pra ~R$5-10/mo total: model downgrade pra Flash-Lite
+ schedule reduzido pra 2x/dia.

### Changed
- `GEMINI_MODEL` migrado de `gemini-2.5-flash` para
  `gemini-2.5-flash-lite`. Mesmo prompt + responseSchema; Lite tem
  precisao suficiente pra categorizacao + tagging. Custo 5-10x menor.
- `installTriggers()`: `cleanAndLabel_` migrou de `everyHours(1)` para
  `atHour(7).everyDays(1)` + `atHour(19).everyDays(1)` no fuso
  `CONFIG.TZ`. Roda nas mesmas janelas que `generateReport_`. Reduz
  invocacoes/dia de 24 para 2 (12x menos chamadas, 12x menos cost).
- Comentario do bloco TRIGGER SETUP atualizado com a razao da mudanca
  e a projecao de custo esperada.

### Operational
- User precisa rodar `installTriggers` uma vez via Apps Script UI
  (Run dropdown) ou via `clasp run installTriggers` se a Apps Script
  API estiver habilitada na conta. Sem isso o trigger antigo
  (everyHours(1)) continua ativo apesar do code novo. Confirmacao via
  Logger.log: "Triggers installed: cleanAndLabel 2x/day + generateReport
  2x/day at 07/19h BRT."

---

## [2.4.2] - 2026-05-30

### Added

- **Built-in `HARD_TRASH_SENDERS` baseline list in code.** Senders that
  are 100% junk independent of which workspace clone is running can now
  be committed to source instead of needing to be set via Script
  Property on every deployment. First entry: `aliexpress`. The runtime
  property `HARD_TRASH_SENDERS` and the legacy `BLACK_LIST` are still
  read and concatenated, so existing user-managed additions
  (`promoteSoftToHard()`, manual UI edits) are preserved verbatim.

### Changed

- **Gemini categorization prompt tightened for GitHub emails.** GitHub
  notifications (notifications@github.com, noreply@github.com) now
  default to LIXO unless the email is a direct PR review request
  ("review_requested" / "requested your review on" / explicit
  assignment). Comments on PRs you already opened/reviewed, CI status,
  Dependabot, push notifications, social interactions, mentions in
  discussions, security advisories - all LIXO. Mirrors the
  `argus 2.4.1` gmail-fast-poll tightening so both ends of the email
  pipeline drop GitHub noise consistently.

---

## [2.4.1] - 2026-05-23

### Fixed

- **Added OAuth scope `https://www.googleapis.com/auth/script.send_mail` to `appsscript.json`.** Without it, `emailReport_` from v2.4.0 throws `Exception: Specified permissions are not sufficient to call MailApp.sendEmail` and the report email is never delivered. Verified end-to-end on the 22:34 BRT manual run: report saved to Drive, email delivered, and `resetStats_` completed in 135ms. **Re-consent prompted on next run.**

---

## [2.4.0] - 2026-05-23

### Added

- **Opt-in email delivery of the report.** New `emailReport_(props, filename, md, driveUrl)` runs right after `saveReportToDrive_` inside `generateReport_`. When ScriptProperty `REPORT_EMAIL` is set, the same Markdown that was saved to Drive is sent via `MailApp.sendEmail` to that address, with the `.md` attached and a link back to the Drive file appended to the body. When `REPORT_EMAIL` is unset, behaviour is unchanged (Drive only, default since v2.0). Subject is `[gmail-organizer] <yyyy-MM-dd-HHh>`.

### Fixed

- **`generateReport_` no longer leaves stats accumulated when the post-save step fails.** The 2026-05-22 19h trigger crashed with an Apps Script INTERNAL error after the report was already saved to Drive: `resetStats_` hung for around 3 minutes and the function exited with Falha, so the counters for the next period inherited the previous period's totals. Both `emailReport_` and `resetStats_` are now individually wrapped in try/catch with timing logs, so a failure in one does not skip the other and the trigger always completes cleanly.

### Changed

- **`resetStats_` rewritten as a single batched `setProperties` call** instead of around 20 sequential `deleteProperty` round trips. Counters are now zeroed in place (`'0'` for numeric stats, `'[]'` for the JSON-array stats `STATS_ALERTS`, `STATS_SOFT_TRASH_ADDED`, `STATS_HARD_TRASH_ADDED`). This is functionally identical to the previous delete loop because `readStats_` already uses `|| '0'` / `|| '[]'` fallbacks, and it removes the per-key Properties round trips that were the likely root cause of the INTERNAL error above.

### Migration notes

- No config change required. To enable email delivery, set ScriptProperty `REPORT_EMAIL` to the target address. To keep the current behaviour (Drive only), leave it unset.

---

## [2.3.0] - 2026-05-21

### Added

- **Archive on label.** When `cleanAndLabel_` categorizes an email as Newsletter, Outros, Documentos or Contas, the email is now removed from the inbox in the same Gmail API call (label added + `INBOX` removed). The email stays accessible via its category label and in `All Mail`. Categories that need human attention (Urgentes, Pessoais, Revisar) keep the inbox label so they stay visible.
- New `ARCHIVE_CATEGORIES` constant declaring which categories get archived. Change the set to tune which categories silence themselves vs surface.
- `applyLabel_` gains an `archive` boolean parameter so the apply+archive operation stays a single round trip per email.

### Changed

- **Dropped the `newer_than:7d` filter** from the `cleanAndLabel_` inbox query. The hourly trigger now sees the entire unlabeled inbox at any age. The original 7-day filter was there to limit cost in v1; it had the side effect of leaving every email older than a week stuck in inbox forever. With v2's HARD/SOFT shortcuts plus the archive-at-label behaviour above, the trigger can safely drain the entire historical backlog.
- Catalogados report breakdown stays the same shape; the meaning of the "Categorizados por Gemini" subtotal now spans both archived and inbox-retained labels.

### Removed

- Dead code: unused `CATEGORIES` constant, unused `labelIds` local in `processAccount_`, and unused `CONFIG.NEWSLETTER_DENYLIST` (v1 leftover with no readers).
- Stale v2.1.0 one-shot `applyV21Migration_oneshot` (its sender-list migration was executed and the function had no remaining use).

### Notes

- Apps Script execution is capped at 6 minutes per invocation, which is not enough to drain a multi-thousand-email backlog. For the initial v2.3.0 migration the maintainer used a one-off local Python script (not committed) to drain the historical inbox in one pass, then let the hourly trigger maintain steady state. Going forward, normal new-email volume fits comfortably under the per-invocation cap.

---

## [2.2.0] - 2026-05-21

### Added

- Audit divisions in the Drive report. `buildReportMarkdown_()` now emits four blocklist-related sections per report (in order): `## Adicionados ao HARD_TRASH_SENDERS (auto-trash)`, `## Adicionados ao SOFT_TRASH_SENDERS (para revisao)`, `## Em revisao (label Revisar)`, and a closing `## Estado atual das listas` snapshot with the current size of both lists. This makes each report a self-contained audit log of what is being silently excluded.
- `STATS_HARD_TRASH_ADDED` (resurrected with new semantics): tracks senders promoted SOFT -> HARD via `promoteSoftToHard()` during the period, so the next report surfaces them. Cleared on each report along with the other per-period counters.
- **`## Apagados` and `## Catalogados` now show a source breakdown.** Apagados splits the trashed total into "HARD blocklist (silencioso, sem Gemini)" vs "Gemini classificou LIXO". Catalogados splits the labeled total into "SOFT blocklist -> label `Revisar`" vs "Categorizados por Gemini" (with the per-category counts inline). Lets the user audit at a glance how much of the work was done by deterministic blocklists vs by the LLM.

### Changed

- **Drive folder relocated.** Reports now live at `gdrive:memories/inbox/gmail-organizer/` (inside the vault folder) instead of `gdrive:gmail-organizer-reports/` at Drive root. This makes the existing vault bisync (`*/10 * * * * rclone bisync ~/repos/memories gdrive:memories`) deliver reports to the Mac and to Obsidian Mobile on Android with zero extra cron entries.
- **OAuth scope expanded** from `drive.file` to `drive` (full Drive access). Required because the new report folder is created/managed outside the app (it is part of the user's vault on Drive); `drive.file` only allows access to files the app itself created. **Re-consent prompted on next run.**
- `getOrCreateReportFolder_()` renamed to `getReportFolder_()` and stripped of fallback behaviour. It now requires `REPORT_FOLDER_ID` to be set and throws if the property is missing or the folder is inaccessible. Silently creating a stray folder at Drive root would break the bisync, so failing loudly is the desired behaviour.
- Dropped `CONFIG.REPORT_FOLDER_NAME` (no longer referenced).

### Migration notes

After deploy:

1. Set ScriptProperty `REPORT_FOLDER_ID` = `<redacted-drive-folder-id>` (Drive ID of `memories/inbox/gmail-organizer/`). The folder was provisioned ahead of time via `rclone mkdir gdrive-personal:memories/inbox/gmail-organizer`.
2. Trigger any function from the editor (e.g. `setupCredentials()`). Apps Script will prompt for re-consent with the new `drive` scope - approve from the personal account.
3. Next `generateReport_()` (07:00 BRT) writes to the new folder. Mac and Android pick it up via the existing vault bisync; no new cron needed.
4. The legacy `gdrive:gmail-organizer-reports/` folder at Drive root was never populated by v2 (the 19:00 fire on 2026-05-20 failed due to the SyntaxError fixed in v2.0.1). Nothing to migrate.

---

## [2.1.0] - 2026-05-21

### Added

- **`SOFT_TRASH_SENDERS` two-tier blocklist.** A new ScriptProperty alongside `HARD_TRASH_SENDERS`. Emails from a SOFT sender skip Gemini and receive the new `Revisar` Gmail label instead of being trashed. The user reviews the Revisar label periodically and either promotes the sender to HARD (auto-trash) or removes it from SOFT (false positive).
- New `Revisar` label - created automatically per account on the first run that needs it.
- Auto-learn now targets SOFT, not HARD. When Gemini classifies an email as LIXO, the sender is added to `SOFT_TRASH_SENDERS` so subsequent emails get reviewed before being silently dropped. This protects against Gemini misclassification on dual-use senders (vendor notifications and tooling digests were confirmed cases from the 2026-05-21 production run).
- One-shot helpers `migrateHardToSoft()` and `promoteSoftToHard()`. Each reads a CSV from a corresponding ScriptProperty (`MIGRATE_HARD_TO_SOFT` / `PROMOTE_SOFT_TO_HARD`), moves matching entries between the two lists, then clears the trigger property.
- Report (Markdown in Drive) gains:
  - `## Adicionados ao SOFT_TRASH_SENDERS (para revisao)` listing learned senders with instructions to promote or revert.
  - `## Em revisao (label \`Revisar\`)` block surfacing the volume of pending-review emails for the period.

### Changed

- `learnHardTrashSender_()` renamed to `learnSoftTrashSender_()`. Skips senders already covered by HARD or SOFT.
- Stats: `STATS_HARD_TRASH_ADDED` replaced by `STATS_SOFT_TRASH_ADDED`. Report section name updated accordingly.

### Migration notes

After deploy, demote the 5 questionable auto-learned senders from the previous run from HARD to SOFT:

1. ScriptProperty `MIGRATE_HARD_TO_SOFT` = a CSV of the senders to demote, e.g.
   `sender-a@vendor.example,sender-b@vendor.example,notifications@service.example`
2. Run `migrateHardToSoft()` from the editor. Property auto-clears.
3. Next `cleanAndLabel_()` will apply the `Revisar` label to incoming emails from those senders instead of trashing them.

---

## [2.0.1] - 2026-05-21

### Fixed

- Added `.claspignore` to exclude `v1-legacy/`, `docs/`, `README.md` and `.git*` from `clasp push`. Apps Script flattens every `.gs` file in the project into one global scope, so the v1 snapshot was clashing with v2's identical `CONFIG`, function names, and constants - the editor raised `SyntaxError: Identifier 'CONFIG' has already been declared`. Next `clasp push --force` removes the legacy file from the remote project; the v1 snapshot remains in the repo for reference.

---

## [2.0.0] - 2026-05-20

**Major rewrite. Focus shifts from "send a digest email" to "keep the inbox clean and organized".** Argus now owns the read-and-summarize side of the user's email; this project becomes a Gmail organizer that runs on Apps Script (GCP) so the Mac does not have to be on.

### Added

- `cleanAndLabel_()` hourly job: scans each account's inbox, categorizes new emails with Gemini, applies Gmail labels (`Contas`, `Newsletter`, `Urgentes`, `Pessoais`, `Documentos`, `Outros`) and moves `LIXO` to the Gmail Trash (purged in 30 days by Gmail itself). Idempotent across runs - the inbox query excludes messages already touched by our labels.
- `generateReport_()` time-driven job: runs at 07:00 and 19:00 BRT, consolidates counters accumulated since the last report into a Markdown file under the `gmail-organizer-reports` Drive folder, then resets the counters. Folder id is cached in `REPORT_FOLDER_ID` ScriptProperty.
- Pre-Gemini sender hard-block via new `HARD_TRASH_SENDERS` ScriptProperty (CSV of substrings against the `From` header, lowercased). Cuts Gemini token cost for definitively-promotional senders.
- Gemini per-email `alert` field. Surfaces tight-deadline items (billing about to expire, security urgencies). Alerts are accumulated in `STATS_ALERTS` and appear at the top of the next report.
- New `installTriggers()` and `removeAllTriggers()` helpers replacing `setupDailyTrigger` / `removeTriggers`.

### Changed

- **OAuth scopes expanded** from `gmail.readonly + gmail.send` to `gmail.modify + gmail.labels + gmail.send + drive.file`. **Re-consent required after deploy** - Apps Script will prompt on first run.
- Gemini categorization switched from 4 generic buckets (`IMPORTANTE/INTERESSANTE/NAO_RELEVANTE/PARA_APAGAR`) to 7 action-oriented categories (`LIXO/CONTAS/NEWSLETTER/URGENTE/PESSOAL/DOCUMENTO/OUTROS`). Prompt explicitly handles dual-use senders (Airbnb booking = `DOCUMENTO`, Airbnb promo = `LIXO`) - brand is the hint, content is the decision.
- `Code.gs` shrunk from 1291 LOC to 664 LOC. v1 HTML digest renderer, newsletter classifier and delete-via-web-app endpoint are gone.

### Removed

- Daily HTML digest email (delegated to Argus's morning digest on Telegram).
- Newsletter summarization (delegated to Argus reading the `Newsletter` Gmail label - separate change in `argus/sources/gmail-sync` to follow).
- Web App `doGet` endpoint, delete-confirmation pages and `DELETE_TOKEN` flow. The organizer now auto-trashes `LIXO`.
- The 4-category Gemini prompt and all v1 categorization helpers. Snapshot of the old `Code.gs` is preserved at `v1-legacy/Code.gs`.

### Migration notes

1. Update ScriptProperties:
   - Drop `WEB_APP_URL`, `DELETE_TOKEN`, `SUMMARY_RECIPIENT`, `EXCLUDED_CATEGORIES` (no longer read).
   - Optional new: `HARD_TRASH_SENDERS` (CSV of sender substrings to trash before Gemini).
2. `clasp push` the new `appsscript.json` and `Code.gs`.
3. In the Apps Script editor, run `setupCredentials()` once - verifies required keys.
4. Run `installTriggers()` once - removes old triggers and installs hourly + 07/19h triggers.
5. Apps Script will prompt for the new OAuth consent (Gmail modify + Drive file) on the next run. Approve from the personal account that owns the script.
6. First report appears under Drive folder `gmail-organizer-reports` (auto-created). Mirror to vault via existing rclone bisync if desired.

---

## [1.4.0] - 2026-04-23

### Added

- **Two-email split**: digest now produces `[Digest]` (inbox-worthy emails) and `[Newsletter Digest]` (newsletters with context) in separate messages
- Newsletter detection via `List-Unsubscribe` header + `CATEGORY_PROMOTIONS`/`CATEGORY_UPDATES` labels + sender patterns, with transactional denylist (GitHub, Supabase billing, Vercel security, banks, payment processors)
- Dedicated Gemini prompt for newsletters that extracts **thesis** (headline-style, not "Newsletter sobre X"), 3 **takeaways** (concrete bullets), **theme** (AI_TECH / NEGOCIOS / EVENTOS / DESENVOLVIMENTO / LIFESTYLE / OUTRO), and **interest score** (1-5)
- `destaques_do_dia` cross-cutting summary at top of newsletter digest
- Newsletter body budget raised from 800 to 4500 chars, with aggressive HTML cleaning (strips `<style>`, `<script>`, image tags, anchor hrefs, unsubscribe/copyright boilerplate)
- Cross-account deduplication: same sender + subject on multiple accounts now collapses to one entry with a "N contas" badge
- Empty-account sanity probe: when an account returns 0 emails, fetches `/users/me/profile` to distinguish "inbox vazia" from "token quebrado" and surfaces the distinction in the status banner

### Changed

- Renamed `sendDigestEmail_` → `sendGeneralDigest_` (general digest no longer includes newsletters)
- Account status banner shows amber warning for `0 emails` + healthy probe (vs green for `N emails`)

### Added (utilities)

- `extractBodies_()` returns both plain and HTML bodies for flexible downstream use
- `cleanNewsletterHtml_()`, `isNewsletter_()`, `dedupeEmails_()`, `probeAccountProfile_()`, `categorizeNewslettersWithGemini_()`, `sendNewsletterDigest_()`, `buildNewsletterHtmlEmail_()`, `buildNewsletterSection_()`
- `testNewsletterClassification_()` debug helper that logs how yesterday's emails split between general and newsletter buckets

---

## [1.3.0] - 2026-04-17

### Changed

- Daily trigger time changed from 8h to 7h BRT

---

## [1.2.0] - 2026-04-17

### Added

- Account error tracking and reporting in digest email (status banner shows which accounts succeeded/failed)
- Dedicated error notification email when all accounts fail (no more silent failures)
- Pagination for email fetching (previously capped at 50 per account silently)
- Per-email and per-section "Apagar" (delete) buttons via Web App endpoint with confirmation page
- `WEB_APP_URL` and `DELETE_TOKEN` config via Script Properties
- `doGet` Web App endpoint for email deletion with token-based auth
- `generateDeleteToken` utility function
- Startup logging of configured accounts, blacklist, and excluded categories

### Changed

- Gemini prompt overhauled: explicit PARA_APAGAR examples (marketing, promos, social notifications), enforced 20-30% minimum for spam categorization
- Category definitions refined: IMPORTANTE includes financial disputes/bills, NAO_RELEVANTE includes CI/CD noise, INTERESSANTE limited to original content newsletters
- Section headers now use flexbox layout with "Apagar todos" bulk delete buttons

### Fixed

- 3 out of 4 account refresh tokens were expired (personal, hellocrypto, compatinhas) — all regenerated and saved in Script Properties

---

## [1.1.0] - 2026-03-15

### Added

- `BLACK_LIST` support via Script Properties to filter out unwanted senders before processing
- `EXCLUDED_CATEGORIES` support via Script Properties to skip entire Gmail categories (e.g. promotions)
- `.env` file for local reference of blacklist and excluded categories (git-ignored)

### Changed

- `BLACKLIST` and `EXCLUDED_CATEGORIES` in `CONFIG` now load dynamically from Script Properties instead of hardcoded empty arrays

---

## [1.0.1] - 2026-03-15

### Fixed

- Exclude own digest emails from fetch query (`-subject:[Digest]`)
- Fix stats layout on desktop

## [1.0.0] - 2026-03-14

### Added

- Initial release: Gmail Daily Digest with Gemini AI
- Multi-account support via OAuth refresh tokens
- Gemini AI categorization (IMPORTANTE, INTERESSANTE, NAO_RELEVANTE, PARA_APAGAR)
- HTML digest email with stats and direct Gmail links

---

**Note**: This changelog is maintained manually and may not include all minor changes. For detailed commit history, please refer to the Git log.
