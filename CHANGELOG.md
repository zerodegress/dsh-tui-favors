# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-24

### Added

- Host row that pins the four dsh-TUI conversation defaults — model route,
  reasoning effort, agent preset and permission mode — by writing
  `~/.dsh-tui/{model,effort,agent-preset,permission}.json` synchronously during
  `apply`, i.e. before dsh-TUI resolves its boot route.
- `pin` mode: a preference file another writer changes (`/model`, `/effort`,
  `/preset`, `/permission`) is restored on the next check, so every new
  conversation and every launch returns to the favorites.
- `/favors` and `/favors apply` commands, reporting each knob's pinned value,
  the file's current value, and anything that outranks it (`DSH_TUI_PRESET`,
  `DSH_PERMISSION_MODE`, the `/settings` default effort).
- Config validation that drops junk instead of writing it: half model routes,
  non-preset ids, session-only or reserved permission values, control
  characters. A bad config degrades to "that knob is not pinned".
- Offline verification (`scripts/verify.mjs`) plus a cross-check against the
  installed dsh-TUI preference readers (`scripts/verify-host.mjs`), asserting
  both sides parse each other's files.

### Notes

- Reasoning effort is pinned per launch: dsh-TUI caches the preferred tier in
  the process, so an in-session `/effort` change lasts until the next start.
- `permission.json` only seeds sessions that never picked a permission mode
  themselves; that is dsh-TUI's own rule.
