# Changelog

All notable changes to this project will be documented in this file.

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
