# Changelog

## [0.0.1] - 2024-12-XX

### Changed
- Rebranded from "Rofan Visualboard" to "Vivid Chat"
- Initial release version reset to 0.0.1

## [0.2.1] - 2024-12-XX

### Fixed
- Content script auto-injection: Automatically injects content script when "Receiving end does not exist" error occurs
- Fixed first turn analysis failure due to content script not loaded

### Changed
- Added "scripting" permission to manifest for dynamic content script injection
- Improved error handling in service-worker.js for content script connection issues

## [0.2.0] - 2024-12-XX

### Added
- Version display in sidepanel footer
- Build script for creating distribution zip files
- Support for language-prefixed chat URLs (e.g., `/en/chat/...`)
- Phase2 complete: Multi-scene support, Cast/Name management (castHints, castStore, aliasMap), Ghost character creation
- Dev/Prod server switching via Options Page
- Skip policy redesign (no skip if board is empty, retry on failure)
- Character matching with refId and isNew flags
- iframe → sidepanel cast synchronization

### Added
- scenarioKey extraction from rofan.ai chat URLs
- scenarioKey included in STORY_STATE_UPDATE messages to iframe
- scenarioKey calculation in content.js (rofan.ai tab context)
- scenarioKey passed through REQUEST_LAST_AI_MESSAGE and NEW_LAST_AI_TURN messages

### Changed
- STORY_STATE_UPDATE message now includes scenarioKey field
- scenarioKey is calculated in content.js instead of sidepanel.js (fixes null scenarioKey issue)

## [0.1.0] - 2024-12-XX

- Initial versioning setup

