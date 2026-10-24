# dsh-tui-favors

Pin the four values every new dsh-TUI conversation starts on — **model route, reasoning effort, agent preset and permission mode** — so `/new` and every launch return to your favorites instead of whatever the last session happened to end on.

## Install

```
/plugin install github:zerodegress/dsh-tui-favors
```

Restart dsh-TUI afterwards: the row writes the preference files during startup.

## Use

Favorites come from two layers with the same shape: your profile's row config, and an optional `~/.dsh-tui/favors.json` that wins key by key.

### Layer 1 — the profile row

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

### Layer 2 — `~/.dsh-tui/favors.json`

Flat JSON, the same keys as the `config:` block above, sitting next to `model.json` and friends:

```json
{
  "provider": "magpie",
  "model": "group/cheap-deepseek-v4-1-flash",
  "effort": "max",
  "preset": "ptc",
  "permission": "workspace-write",
  "_comment": "machine-local, not in git"
}
```

It applies without a restart: each `pin` check re-reads it (2 s by default). Knobs you leave out keep the row's value, and a value that fails validation is reported instead of applied — the row's value stays, so a typo never silently un-pins a knob. A whole copy-pasted patch row (with `id`/`name`/`config`) is refused with a hint to keep only the keys inside `config`. `enabled: false` on the profile row is a kill switch: the file is then not even read.

Then, inside the TUI:

- `/favors` — show each knob: the pinned value, its source (`[favors.json]` or `[profile row]`), what the preference file currently holds, and whether something outranks it (`DSH_TUI_PRESET`, `DSH_PERMISSION_MODE`, the `/settings` default effort). The `source:` line reports whether the file is missing, in effect, or ignored.
- `/favors apply` — re-read the file and rewrite the four files immediately instead of waiting for the next `pin` check.

With `pin: true` (the default) a value you change mid-session with `/model`, `/effort`, `/preset` or `/permission` still applies to that conversation, but its preference file is restored, so the next conversation starts on the favorite again. Set `pin: false` to write once per boot instead.

Two limits worth knowing: reasoning effort is pinned per launch (dsh-TUI caches the preferred tier in-process, so an in-session `/effort` lasts until the next start), and `permission.json` only seeds sessions that never picked a permission mode themselves.

中文说明见 [README.zh.md](README.zh.md)；变更记录见 [CHANGELOG.md](CHANGELOG.md)。
