# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `~/.dsh-tui/favors.json`: a flat, user-owned config file with the same keys as
  the row's `config:` block. It outranks `cordis.patch.yml` knob by knob, is
  re-read on every `pin` check (no restart needed), and is validated by the same
  parsers — an unusable value is reported and skipped, leaving the row's value
  in place instead of un-pinning the knob. A copy-pasted patch row is refused
  with a hint, `_`-prefixed keys work as comments, and a broken file degrades to
  the row config with one log line.
- `enabled: false` on the profile row is a hard kill switch: the favorites file
  is not read at all, so a user file cannot resurrect a deployment-disabled row.
- `/favors` marks each knob with the layer that supplied it (`[favors.json]` or
  `[profile row]`) and adds a `source:` line describing the file's state.

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
