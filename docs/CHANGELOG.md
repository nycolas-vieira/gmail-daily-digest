# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**:date: ORDER**: Entries are organized in **descending chronological order** (newest first).

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
- Auto-learn now targets SOFT, not HARD. When Gemini classifies an email as LIXO, the sender is added to `SOFT_TRASH_SENDERS` so subsequent emails get reviewed before being silently dropped. This protects against Gemini misclassification on dual-use senders (e.g. `sender@vendor.example`, `cloud@service.example`, `notifications@github.com` - confirmed cases from the 2026-05-21 production run).
- One-shot helpers `migrateHardToSoft()` and `promoteSoftToHard()`. Each reads a CSV from a corresponding ScriptProperty (`MIGRATE_HARD_TO_SOFT` / `PROMOTE_SOFT_TO_HARD`), moves matching entries between the two lists, then clears the trigger property.
- Report (Markdown in Drive) gains:
  - `## Adicionados ao SOFT_TRASH_SENDERS (para revisao)` listing learned senders with instructions to promote or revert.
  - `## Em revisao (label \`Revisar\`)` block surfacing the volume of pending-review emails for the period.

### Changed

- `learnHardTrashSender_()` renamed to `learnSoftTrashSender_()`. Skips senders already covered by HARD or SOFT.
- Stats: `STATS_HARD_TRASH_ADDED` replaced by `STATS_SOFT_TRASH_ADDED`. Report section name updated accordingly.

### Migration notes

After deploy, demote the 5 questionable auto-learned senders from the previous run from HARD to SOFT:

1. ScriptProperty `MIGRATE_HARD_TO_SOFT` =
   `sender@vendor.example,cloud@service.example,notifications@github.com,replies@vendor.example,noreply@teams.example`
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
