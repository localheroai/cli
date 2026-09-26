# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added
- When a pull request rewords a source text, `translate --changed-only` (and `ci`) now updates the existing translations of it in the same run and commits them together with any new translations. Localhero decides per language whether a translation needs to change. Translations that already fit are left alone, as are translations someone edited in the pull request. The aligned values are then sent to Localhero for review on the pull request. The run log shows per language how many translations were aligned, already fit or were skipped, with the reason for each skip. This works for YAML and JSON files, multi-language files included; PO files are not aligned. It runs only for projects that have alignment turned on in Localhero, and other projects see no change. `postTranslateCommand` also runs when a run only wrote aligned values.

### Fixed
- With signed commits (`github.signedCommits: true`), a push to the branch while a run was in progress could be overwritten. The CLI committed its files on top of the newer push, so an edit in that push to one of the same translation files was silently reverted to the version the run started from. The CLI now checks what the newer commits changed. If they left the files it is about to commit alone (for example a code-only push), it commits on top of them as before. If they changed any of those files, or GitHub can't give a complete answer (a force-push, a very large push, an API error), it skips the commit and exits successfully. The notice says which case it was: a push that changed translation files starts a fresh run on its own; otherwise re-run the workflow. A sync from Localhero that is skipped this way is not marked as completed; sync again to commit it. The plain `git push` path is unchanged.
- `translate` and `ci` now fail in GitHub Actions when the translations could not be committed. Before, a missing `GITHUB_TOKEN` or a rejected push printed a yellow notice and the check went green with no translations on the branch. The run now ends with an `::error::` annotation that says what to fix: pass `GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}` in the step env or install the Localhero GitHub App, grant `permissions: contents: write`, or run from a pull request (a manual `workflow_dispatch` run has no pull request branch to commit to). A sync from Localhero already failed when its commit failed and is unchanged. `--skip-commit`, nothing to commit, and a signed commit skipped because the branch moved still pass; that skip now shows as a `::warning::` annotation. Outside GitHub Actions nothing changes.
- On a pull request, "Alignment skipped: this PR has more than 1,000 translation changes" was also printed when the base branch could not be found. The message now names the actual reason.

## [0.0.74] - 2026-09-25

### Added
- `check` command: audits translation files offline, with no API key and no credits. It reports missing keys, placeholder mismatches, structure and plural-shape mismatches, missing plural categories (e.g. Polish without `few`/`many`), orphan keys and empty or identical values. Supports `--json`, `--format github` and `--fail-on`.
- `check` in GitHub Actions needs no flags. Its annotations carry line numbers, which puts each finding next to the changed line in the pull request diff. In a pull request it fails on every problem the pull request introduced, placeholders included; problems already on the base branch are counted in the job summary. `--full` checks every key, `--format text` prints the plain report.

### Fixed
- New files in a pull request are translated again. Since 0.0.60, `--changed-only` (and so `ci` on a PR branch) could not tell a file that is new in the branch from a git error, and skipped it: a new source file was never translated, and new target files and their keys never reached Localhero for review. This affected every project, not only multi-language files.
- A multi-language file (`multiLanguageFiles: true`) that only has the source language, like a new `welcome.i18n.yml` with just `en:`, is now picked up and the other languages are added to it. Before, it was skipped with "Could not extract locale from path".
- A language key in a multi-language file that isn't one of your locales, like `no:` in a project that uses `nb`, is now named in a warning and left untouched, and the rest of the file is still translated. Before, the whole file was skipped.

## [0.0.73] - 2026-09-25

### Fixed
- `translate` and `ci` now fail when the project in `localhero.json` does not exist or belongs to another organization. Before, a pull request run with no missing keys printed two yellow warnings, then "No changed keys need translation", and passed; the PR's edited translations and key manifest never reached Localhero. The run now stops before doing any work with an error that names the project id and points at `projectId` in `localhero.json` and the API key's organization. Network and server errors on the review upload and key manifest calls are still warnings.

## [0.0.72] - 2026-09-25

### Fixed
- A locale file in one folder is no longer paired with an unrelated folder at the same depth. When `countries/sv.yml` did not exist, `countries/en.yml` was matched with `pressroom/sv.yml`, so `translate` wrote the Swedish country names into the pressroom file and `check` reported them missing there. Translations for a folder without a target file now go to a new file in that folder.

## [0.0.71] - 2026-09-24

### Fixed
- Source and target files are now paired correctly when the source locale code also appears inside a word in the file name (`document.en.yml`, `tenant_signup.i18n.yml`, `orders.de.yml`). Before, the target file was not found, so a full `translate` treated every key in it as missing and overwrote existing translations. Edits to that target file in a pull request were not imported either.
- A new locale file is created at the right path when the source locale follows an underscore (`content_en.json` now gives `content_sv.json`, where it used to write into the source file) or when a hyphenated file sits in a locale directory (`en/my-entries.yml`).

## [0.0.70] - 2026-09-16

### Fixed
- Pushing without the Localhero GitHub App installed now says so. Without the app the push falls back to the workflow's `GITHUB_TOKEN`, which GitHub never triggers downstream workflows from, so required checks on that commit wait forever with nothing to report. That fallback was the one path that stayed silent, leaving the stalled pull request unexplained.
- The generated workflow explains the `POT-Creation-Date` line it writes, so it reads as the optional tidying it is rather than a step you must not touch.
- Brand spelling and an apostrophe in the CLI's own output.

## [0.0.69] - 2026-09-15

### Fixed
- Installing no longer prints a deprecation warning. `glob` is on v13, which also clears two high-severity advisories in its dependencies.
- The import summary no longer prints a "missing" count per language. It was counted against the whole project's key space, so a language with fewer plural forms than the others was reported as missing forms it cannot have.

## [0.0.68] - 2026-09-15

### Fixed
- Entries gettext marked `fuzzy` are translated instead of being treated as done. `msgmerge` writes a guess copied from a similar string and flags it; `msgfmt` then leaves the entry out of the compiled catalog, so the app shows the source text while the file looks translated. Reword a string, run `makemessages`, and the old translation stayed in place and never reached your users. Those entries are now sent for translation, and the flag is cleared once every plural form the catalog declares has a real value. It stays put when only some forms come back, when the value is whitespace, and when the translation breaks the newline agreement gettext requires, so a half-written entry is never marked done.
- A run where every job fails no longer reports success. A job that ran out of status checks was dropped without recording the language, so the summary printed "Translations complete" for a run that wrote nothing, and `ci` inherited it: a GitHub Action step could pass having translated nothing.
- New Action workflows are generated with `actions/checkout@v7`. Existing workflows are untouched; re-run `init` or edit the line to pick it up.

## [0.0.67] - 2026-09-14

### Added
- `init` now works on a stock Django project. Django writes the source strings to a `.pot` and deletes it, so nothing on disk held the source locale and the first import failed every time. The `.pot` is now part of Django's file pattern, `makemessages` runs with `--keep-pot`, and when no source is found `init` offers to run the extraction and re-imports if it succeeds.

### Fixed
- A failed import exits non-zero. `init` could import nothing and still exit 0, so a broken first run looked successful.
- `translate` prints the `makemessages --keep-pot` command on a Django project instead of three generic guesses about locale patterns and YAML syntax.
- `POT-Creation-Date` is stripped after the local extraction, so the first Action commit contains translations rather than a date change in every catalog.
- `push`, `pull` and `clone` say so when no API key is set, instead of failing less obviously further in.
- The prune prompt no longer claims the delete is permanent.

## [0.0.66] - 2026-09-10

### Fixed
- Files with more than 200 keys to translate lost everything past the first 200. Each batch now writes its own keys, so every chunk lands.
- Translations Localhero committed itself are no longer re-sent as review proposals on the next push; they report as "already match".
- `--changed-only` no longer claims "All changed keys are already translated" when a reworded source text was staged with its translations kept. It now says what changed and where to review it.
- A failed review upload prints a warning instead of staying silent without `--verbose`.

## [0.0.65] - 2026-09-09

### Fixed
- Array-valued keys are no longer reported as changed on every run. Values are compared structurally instead of by reference, so untouched arrays stop appearing in changed-key counts and in the PR key manifest. Affects any project with array values, including Rails `date.*` blocks.

## [0.0.64] - 2026-09-05

### Fixed
- Keys excluded by `ignoreKeys` no longer appear in the PR key manifest, so they stop being reported on the PR page as "not sent for translation". Deletions are still reported regardless of `ignoreKeys`, and PO files are unaffected since `ignoreKeys` does not apply to them.

## [0.0.63] - 2026-09-05

### Fixed
- Inserting a nested key and a sibling at the same offset could nest the block under the wrong parent and produce invalid YAML (#509). Same-offset insertions now keep deeper blocks with their own keys.
- YAML is re-parsed before it is written. A bad in-place write falls back to a full rewrite instead of shipping a broken file; deletions that would break the file are refused. New duplicate keys are refused, existing ones tolerated.
- Folded block scalars (`>-`) stay folded on update instead of being rewritten as `|-`.
- Only the keys a run requested are written. Extra keys in a translation response no longer overwrite local values.

## [0.0.62] - 2026-08-25

### Added
- `init` sets up Django and Phoenix projects so the GitHub workflow actually works on the first PR. Gettext stacks only translate what is already in the catalogs, so a workflow without an extract step ran green and translated nothing. The generated workflow now runs `makemessages` (Django) or `mix gettext.extract --merge` (Phoenix) before translating, installs the toolchain it needs, and watches your source files so a PR that adds a new string triggers a run. Dependency manager is picked from the lockfile (uv, poetry, pipenv, or pip), and Phoenix umbrella apps get the right `working-directory`.

### Fixed
- `init` no longer mistakes a source directory for a translation directory on gettext projects. Wagtail ships a `locales/` app and Saleor a `translations/` package, and both were being suggested as the catalog path. Detection now looks for an actual `*/LC_MESSAGES/*.po` layout.
- A source file that fails to parse is now reported and exits non-zero. Previously it was dropped at discovery and the run still printed "✓ Translations complete!" and exited 0, so every key in a file with a syntax error was excluded from every run with nothing to show for it.
- When the locale plural-categories fetch fails, the warning is always shown instead of only under `--verbose`. Without those categories, missing-detection falls back to exact key matching, which re-flags already-translated plural keys as missing and spends credits on every run. The warning now says so, and names the actual cause (bad API key, rate limit, network) rather than a generic failure.

### Changed
- Dropped the unused `@oclif/core` dependency and bumped `yaml`, `glob`, and `nanoid`.

## [0.0.61] - 2026-08-11

### Added
- `init` recognises Phoenix/Elixir projects (via `mix.exs`) and suggests `priv/gettext/` with a `**/*.po` pattern, instead of leaving you to fill the paths in by hand.

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
