# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**:date: ORDER**: Entries are organized in **descending chronological order** (newest first).

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
