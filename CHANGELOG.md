# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Changed
- Removed the unused `@oclif/core` dependency (the CLI is built on commander). Shrinks the install and clears 11 Dependabot alerts for transitive packages only oclif pulled in.
- Bumped `yaml` to ^2.8.3 (CVE-2026-33532 hardening) and `glob` to ^10.5.0.

## [0.0.60] - 2026-07-16

### Added
- Source-locale edits made directly in a PR are now detected by `translate --changed-only` and sent to the review page.
- Every PR-detected change now carries the source file's current value (`source_value`), so the backend can create keys it has never imported.

### Fixed
- A git failure while diffing against the base branch no longer reports every key in the file as added, only a file genuinely missing at the base ref does.
- Target files without a matching source file no longer count toward the PR-ingestion change cap.

## [0.0.59] - 2026-06-24

### Added
- Bring-your-own-translations: locales with auto-translation turned off (a project setting) are no longer machine-translated. Their keys are still added to the review flow as empty, editable rows so a human can fill them in, and `translate` now reports `Auto-translation off for <locale>` and leaves those files untouched instead of counting them as translated.
- `translate --changed-only` detects translations you edited directly in a PR (added or updated target values, via git diff) and sends them to the review page, so manual edits are tracked alongside machine translations.

## [0.0.58] - 2026-06-23

### Fixed
- New entries appended to an existing `.po` file are now separated by a single blank line instead of stacking up to three, and the file keeps exactly one trailing newline. Cosmetic only (the output was already valid), but it keeps Export-to-GitHub diffs clean.

## [0.0.57] - 2026-06-23

### Fixed
- Entries added to an existing `.po` file during Export to GitHub now include their `#:` source-reference comments. Previously references were only written for brand-new files (0.0.56); when a new key was added to a locale file that already existed, the reference was dropped.

## [0.0.56] - 2026-06-23

### Fixed
- Newly created `.po` files now keep their `#:` source-reference comments during Export to GitHub (the `ci` sync path). The server was sending the references, but they were dropped when a target locale file was written from scratch; existing files were unaffected.

## [0.0.55] - 2026-06-23

### Fixed
- Generated `.po` files no longer come out with blank `msgid ""` entries or dropped `msgctxt` context. This affected gettext/Phoenix setups where a new target locale file is written from scratch (e.g. `LC_MESSAGES` layouts). New `.po` files also keep flags, translator comments, and plural grouping.

### Changed
- An optional `.zero` plural defined in the source is no longer added to every target locale by default. A locale only gets a plural form it actually uses (its CLDR set), so optional forms like `.zero` aren't forced into languages that don't need them. Propagating it everywhere is now a per-project setting for teams that want it.

## [0.0.54] - 2026-06-23

### Fixed
- `translate` no longer writes a value with no space after the key (`key:value`) when filling a key that previously existed with an empty value.
- Numeric Rails config like `precision: 0` is no longer treated as a missing translation and overwritten with the source value.
- Filling a plural form on a key that was a plain string (e.g. adding a `.zero`) now keeps the original value as `.other` instead of dropping it. Existing list values are preserved the same way.

## [0.0.53] - 2026-06-22

### Fixed
- `translate` no longer re-translates the same Rails YAML plurals on every run for languages with a single plural form (Indonesian, Japanese, Chinese for example). These keys now settle after the first run instead.
- `push --prune --force` no longer flags every key for deletion in locale-wrapped files like `rails.en.yml`.

### Added
- Gettext (`.po`) locales are picked up from the standard `LC_MESSAGES` directory layout.
- Imports only include the locales listed in `outputLocales`.

## [0.0.52] - 2026-06-12

### Added
- Custom locale support. Locales that aren't on the standard list, can be declared during `localhero init`: the CLI asks for a display name and a base language, saves them as `customLocales` in `localhero.json`.
- File scanning now finds custom and Rails-style underscore locale files when the locale is configured. `zh_cn.yml`, `devise.ja_easy.yml`, and suffixed names like `messages_zh_cn.yml` are translated.

### Fixed
- `translate` and `pull` write YAML under the locale spelling from `localhero.json`. Job results and sync updates that report canonical codes (`zh-CN`) no longer add a duplicate top-level key next to `zh_cn:` or cause the same keys to re-translate on every run.
- `init` exits with a non-zero status when project creation fails, instead of printing the error and exiting 0.

## [0.0.51] - 2026-05-20

### Fixed
- `localhero.json` no longer ends up with `"lastSyncedAt": null` after sync runs. The field is omitted entirely when there's no real timestamp to record, which avoids a spurious diff line on every customer PR.
- `localhero.json` now ends with a trailing newline like every other file the CLI writes, instead of `\ No newline at end of file`.

## [0.0.50] - 2026-05-20

### Fixed
- YAML files keep their original formatting when the CLI edits them. Only the keys we actually change get rewritten; everything else, including multi-line plain scalars and the layout of untouched keys, stays byte-identical.
- `--changed-only` no longer over-translates. A new key with a name that happens to also exist in another file (e.g. `subject`) only triggers translation in the file where it actually changed, not in every sibling file that has the same bare key.
- Multi-language files now translate correctly on first use. The CLI tells the server when a file is multi-language so the server creates the right kind of `TranslationFile` record up front.

### Changed
- Signed-commit sync runs stack a follow-up commit instead of amending the bot's previous commit, so the audit trail and signature chain stay intact.

## [0.0.49] - 2026-05-07

### Added
- `translate --changed-only` now sends a manifest of source-language keys removed in the PR diff. The Localhero server soft-deletes those keys on PR merge (preserving an audit trail) and restores them automatically when the PR closes without merging. 
- `translationFiles.baseBranch` config option. Tells `ci` which branch counts as the project's default for `--changed-only` detection. Lets repos using `develop`, `production`, or any other non-`main`/`master` default behave correctly.

### Changed
- `ci` now warns when `GITHUB_REF_NAME` is unset (running outside CI or in a misconfigured runner) and falls back to a full translation rather than acting on an empty branch name.

## [0.0.47] - 2026-04-28

### Fixed
- `--changed-only` now compares against the merge-base of the base branch and `HEAD` (i.e. `git diff base...HEAD`), not the base branch tip. Fixes a long-running-branch case where commits made on `main` after the branch point were attributed to the feature branch.

## [0.0.46] - 2026-04-27

### Added
- `github.signedCommits` config flag. When set to `true`, the CLI commits translations via GitHub's GraphQL `createCommitOnBranch` mutation. GitHub auto-signs the resulting commits, so they pass repos protected by the `required_signatures` ruleset rule. 

## [0.0.45] - 2026-04-26

### Added
- Multi-language file support (beta) for YAML and JSON files where one file contains multiple locales as top-level keys; opt-in via `translationFiles.multiLanguageFiles`
- `translationFiles.ignoreKeys` config to skip key patterns during push and translate
- `--skip-commit` flag for `ci` command

## [0.0.44] - 2026-04-17

### Fixed
- Generated GitHub Actions workflow now includes a `repository_dispatch` trigger
- Generated workflow checkout `ref` and concurrency `group` now fall back through `client_payload.branch`, `GITHUB_HEAD_REF`, and `GITHUB_REF_NAME` so sync-triggered runs check out the correct branch
- YAML files with duplicate keys no longer crash; the last value is used and a warning is printed
- Lingui `sourceCodePaths` brace expansion is now preserved correctly in generated GitHub Actions workflows

## [0.0.43] - 2026-04-12

### Added
- Lingui framework detection/support
- Non-interactive mode for `init` command (`--yes` flag) for AI agents and CI scripts
- next-intl project detection with `messages/` as default translation path

### Changed
- Improved PO file comment handling to preserve Lingui extracted comments and filter internal markers
- Improved PO file fuzzy flag preservation in metadata

## [0.0.42] - 2026-04-01

### Fixed
- Fixed PO file metadata being flattened into separate keys during translate

## [0.0.41] - 2026-03-24

### Added
- PR orphan key detection

## [0.0.40] - 2026-03-21

### Added
- Co-author trailer in translate mode commits

## [0.0.39] - 2026-03-18

### Added
- Support for translation job validation state handling

## [0.0.38] - 2026-02-20

### Fixed
- Fixed updating of PO file key renames on pull

## [0.0.37] - 2026-02-15

### Added
- New `glossary` and `settings` commands for AI agent tool integration
- `--api-key` flag for `login` command to authenticate non-interactively

## [0.0.36] - 2026-02-11

### Changed
- Aligned CI commit message format and switched to API-reported key counts

## [0.0.35] - 2026-02-11

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

[Unreleased]: https://github.com/localheroai/cli/compare/v0.0.52...HEAD
[0.0.52]: https://github.com/localheroai/cli/compare/v0.0.51...v0.0.52
[0.0.51]: https://github.com/localheroai/cli/compare/v0.0.50...v0.0.51
[0.0.50]: https://github.com/localheroai/cli/compare/v0.0.49...v0.0.50
[0.0.49]: https://github.com/localheroai/cli/compare/v0.0.47...v0.0.49
[0.0.47]: https://github.com/localheroai/cli/compare/v0.0.46...v0.0.47
[0.0.46]: https://github.com/localheroai/cli/compare/v0.0.45...v0.0.46
[0.0.45]: https://github.com/localheroai/cli/compare/v0.0.44...v0.0.45
[0.0.44]: https://github.com/localheroai/cli/compare/v0.0.43...v0.0.44
[0.0.43]: https://github.com/localheroai/cli/compare/v0.0.42...v0.0.43
[0.0.42]: https://github.com/localheroai/cli/compare/v0.0.41...v0.0.42
[0.0.41]: https://github.com/localheroai/cli/compare/v0.0.40...v0.0.41
[0.0.40]: https://github.com/localheroai/cli/compare/v0.0.39...v0.0.40
[0.0.39]: https://github.com/localheroai/cli/compare/v0.0.38...v0.0.39
[0.0.38]: https://github.com/localheroai/cli/compare/v0.0.37...v0.0.38
[0.0.37]: https://github.com/localheroai/cli/compare/v0.0.36...v0.0.37
[0.0.36]: https://github.com/localheroai/cli/compare/v0.0.35...v0.0.36
[0.0.35]: https://github.com/localheroai/cli/compare/v0.0.34...v0.0.35
[0.0.34]: https://github.com/localheroai/cli/compare/v0.0.33...v0.0.34
[0.0.33]: https://github.com/localheroai/cli/compare/v0.0.32...v0.0.33
[0.0.32]: https://github.com/localheroai/cli/compare/v0.0.31...v0.0.32
[0.0.31]: https://github.com/localheroai/cli/compare/v0.0.30...v0.0.31
[0.0.30]: https://github.com/localheroai/cli/compare/v0.0.29...v0.0.30
[0.0.29]: https://github.com/localheroai/cli/compare/v0.0.28...v0.0.29
[0.0.28]: https://github.com/localheroai/cli/compare/v0.0.27...v0.0.28
[0.0.27]: https://github.com/localheroai/cli/compare/v0.0.26...v0.0.27
[0.0.26]: https://github.com/localheroai/cli/compare/v0.0.25...v0.0.26
[0.0.25]: https://github.com/localheroai/cli/compare/v0.0.23...v0.0.25
[0.0.23]: https://github.com/localheroai/cli/compare/v0.0.22...v0.0.23
[0.0.22]: https://github.com/localheroai/cli/compare/v0.0.21...v0.0.22
[0.0.21]: https://github.com/localheroai/cli/compare/v0.0.20...v0.0.21
[0.0.20]: https://github.com/localheroai/cli/compare/v0.0.19...v0.0.20
[0.0.19]: https://github.com/localheroai/cli/compare/v0.0.18...v0.0.19
