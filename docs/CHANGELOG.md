# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

**:date: ORDER**: Entries are organized in **descending chronological order** (newest first).

## [Unreleased] - 2026-03-15

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
