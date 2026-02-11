# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- Simplified CI commit messages for translate mode
- Preserved existing quote style when updating YAML translation files to avoid unnecessary diffs

## [0.0.34] - 2026-02-11

### Changed
- Improved CI commit messages with shorter subject lines and unique key counting
- Pull command now sends branch name for better sync tracking

## [0.0.33] - 2026-02-05

### Added
- Support for sync triggers (`LOCALHERO_SYNC_ID` and `LOCALHERO_SYNC_VERSION`) via dipatch event

## [0.0.32] - 2026-01-31

### Fixed
- Fixed `--changed-only` flag not detecting keys in YAML files with locale wrapper (e.g., `{ en: { ... } }`)

## [0.0.31] - 2026-01-30

### Fixed
- Fixed YAML line width handling to prevent formatting issues

## [0.0.30] - 2026-01-30

### Fixed
- Improved sync commit messages for clarity
- Disabled YAML line wrapping to reduce noisy diffs in translation files

## [0.0.29] - 2026-01-26

### Added
- Sync update completion API calls to mark backend-initiated translation updates as completed

### Changed
- GitHub workflow generation now uses official `localheroai/localhero-action@v1` action
- Improved JSON file handling to properly detect and apply source file format to empty target files

### Fixed
- Git push operations retry up to 3 times to handle temporary failures

## [0.0.28] - 2026-01-09

### Added
- Added `--prune` flag to push command to remove stale keys from the API that no longer exist in local files

## [0.0.27] - 2025-12-04

### Changed
- Aligned sync commit messages with translate commit message

### Added
- CommitSummary shared type for consistent commit metadata between sync and translate operations
- sync_url field to SyncResponse type for linking to LocalHero dashboard from commit messages

## [0.0.26] - 2025-12-02

### Changed
- Generated GitHub workflow now triggers on `localhero.json` changes to enable sync mode when backend sets `syncTriggerId`
- Refined bot detection to allow initial bot PR creation while skipping only `synchronize` events from bots (commits)

## [0.0.25] - 2025-11-27

### Added
- New `ci` command for CI/CD environments with intelligent translation modes
  - Sync mode: fetches translations from Localhero.ai sync API when `syncTriggerId` is configured
  - Translate mode with auto-detection: feature branches use `--changed-only`, main/master uses full translation
  - Automatic commit and push of translation changes in GitHub Actions

### Changed
- GitHub Actions workflow now monitors `localhero.json` changes to trigger on backend-initiated sync events
- Refined bot detection to allow initial bot PR events while skipping synchronize events from bots

### Fixed
- Improved branch detection in GitHub Actions using GITHUB_HEAD_REF and GITHUB_REF_NAME
- Config file no longer persists default Django settings unnecessarily

## [0.0.23] - 2025-11-20

### Added
- GitHub App installation token integration for workflow triggering
  - Automatic fallback to GITHUB_TOKEN when App is not installed or unavailable
  - Error handling with specific warnings for authentication failures

## [0.0.22] - 2025-11-11

### Fixed
- Fixed PO file source reference handling to properly split multi-line file references from gettext-parser
- Improved file name matching to prevent cross-context writes between different directories (e.g., server/ vs client/)
- Added null/array guards to processTargetContent for better error handling

### Changed
- Made .pot file detection case-insensitive for more flexible file handling
- Increased retry attempt limits for reliability in slow network conditions

## [0.0.21] - 2025-10-19

### Added
- Failed translation job detection with error reporting when jobs complete without translations
- `.pot` file support for gettext with source key resolution
- `--changed-only` flag for pull command to apply updates only for keys changed in current branch

### Changed
- Better GitHub Actions workflow with concurrency control, bot detection, and manual trigger
- GitHub Actions now uses `--changed-only` for pull requests and full translation for main/master branches

## [0.0.20] - 2025-10-05

### Fixed
- [.po files] Fixed metadata loss bug in translation batching that incorrectly stripped context, plural forms, and comments.
- [.po files] Improved consistency in metadata handling across import operations

### Added
- Git-based file filtering for push command to avoid unnecessary uploads
- --force flag for push command to override change detection and push all files
- Loading spinner on import operations for better user feedback

## [0.0.19] - 2025-10-03

### Added
- **Git-based translation filtering**: New `--changed-only` flag for translate command filters translations to only include keys that changed in the current branch compared to base branch

### Changed
- Improved configuration handling - skip updating config file with defaults to avoid unnecessary writes
- Improved GitHub Actions integration - skip running action on tag pushes, use `skip-translation` label on PRs to skip translation
- Enhanced init command to track setup state for better user experience
- Improved error handling with simplified stack trace printing for better readability
