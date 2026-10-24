# dsh-tui-favors

Pin the four values a dsh-TUI launch starts on — **model route, reasoning effort, agent preset and permission mode** — so every launch returns to your favorites instead of whatever the last session happened to end on. Turn on `pin: true` to extend that to every `/new` within the same run.

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

It applies without a restart when `pin: true` (each check re-reads it, 2 s by default); with the default `pin: false` a new or edited file is picked up on the next launch or by `/favors apply`. Knobs you leave out keep the row's value, and a value that fails validation is reported instead of applied — the row's value stays, so a typo never silently un-pins a knob. A whole copy-pasted patch row (with `id`/`name`/`config`) is refused with a hint to keep only the keys inside `config`. `enabled: false` on the profile row is a kill switch: the file is then not even read.

Then, inside the TUI:

- `/favors` — show each knob: the pinned value, its source (`[favors.json]` or `[profile row]`), what the preference file currently holds, and whether something outranks it (`DSH_TUI_PRESET`, `DSH_PERMISSION_MODE`, the `/settings` default effort). The `source:` line reports whether the file is missing, in effect, or ignored.
- `/favors apply` — re-read the file and rewrite the four files immediately instead of waiting for the next launch or `pin` check.

With `pin: false` (the default) the files are written once per launch: a mid-session `/model`, `/effort`, `/preset` or `/permission` pick stays in effect, and the next `/new` re-reads it — the favorites are back on the next launch. Set `pin: true` to revert those picks, which is what makes every `/new` start on the favorites; `pollMs` (2 s by default) then decides how quickly. It costs one `stat` per check and nothing else.

Two limits worth knowing: reasoning effort is pinned per launch (dsh-TUI caches the preferred tier in-process, so an in-session `/effort` lasts until the next start), and `permission.json` only seeds sessions that never picked a permission mode themselves.

中文说明见 [README.zh.md](README.zh.md)；变更记录见 [CHANGELOG.md](CHANGELOG.md)。
