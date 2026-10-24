# dsh-tui-favors

Pin the four values every new dsh-TUI conversation starts on — **model route, reasoning effort, agent preset and permission mode** — so `/new` and every launch return to your favorites instead of whatever the last session happened to end on.

## Install

```
/plugin install github:zerodegress/dsh-tui-favors
```

Restart dsh-TUI afterwards: the row writes the preference files during startup.

## Use

Add your favorites to your profile's `cordis.patch.yml` (any knob you leave out is not touched):

```yaml
- id: dsh-tui-favors
  name: dsh-tui-favors
  config:
    provider: <provider>
    model: <model-id>
    effort: max
    preset: standard
    permission: workspace-write
```

Then, inside the TUI:

- `/favors` — show each knob: the pinned value, what the preference file currently holds, and whether something outranks it (`DSH_TUI_PRESET`, `DSH_PERMISSION_MODE`, the `/settings` default effort).
- `/favors apply` — rewrite the four files immediately instead of waiting for the next `pin` check.

With `pin: true` (the default) a value you change mid-session with `/model`, `/effort`, `/preset` or `/permission` still applies to that conversation, but its preference file is restored, so the next conversation starts on the favorite again. Set `pin: false` to write once per boot instead.

Two limits worth knowing: reasoning effort is pinned per launch (dsh-TUI caches the preferred tier in-process, so an in-session `/effort` lasts until the next start), and `permission.json` only seeds sessions that never picked a permission mode themselves.

中文说明见 [README.zh.md](README.zh.md)；变更记录见 [CHANGELOG.md](CHANGELOG.md)。
