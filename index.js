/**
 * dsh-tui-favors — pin the four "favorites" a dsh-TUI conversation starts on:
 * model route, reasoning effort, agent preset and permission mode.
 *
 * dsh-TUI already resolves those four knobs from standing preference files
 * under `~/.dsh-tui` (`model.json`, `effort.json`, `agent-preset.json`,
 * `permission.json`). Those files are the documented "where the last session
 * ended" memory: `/model`, `/effort`, `/preset` and `/permission` rewrite them
 * whenever the user picks something else. This plugin makes the deployment's
 * favorites win instead: it writes the four files (only the knobs it was
 * configured with) and, in `pin` mode, restores them whenever another writer
 * changes them, so every new conversation — and every launch — starts on the
 * favorites.
 *
 * Runtime contract (see README):
 *  - `apply` is synchronous and never throws: the profile composition waits
 *    for this row before dsh-TUI resolves the boot route, and a thrown error
 *    would take the TUI down with it.
 *  - No `@deepseek-ai/*` imports and no service injection for the boot write,
 *    so the favorites land even when the TUI services mount later.
 *  - Best effort everywhere: an unwritable `~/.dsh-tui` logs once and the TUI
 *    keeps running on its own preferences.
 *
 * @module dsh-tui-favors
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

/** Cordis plugin name (the loader row's `name`). */
export const name = 'dsh-tui-favors'

/** Preference file names dsh-TUI itself reads, keyed by knob. */
const PREF_FILES = {
  model: 'model.json',
  effort: 'effort.json',
  preset: 'agent-preset.json',
  permission: 'permission.json',
}

/** Every knob this plugin can pin, in report order. */
const KNOBS = ['model', 'effort', 'preset', 'permission']

/** Ids a preset directory may use (the boundary `presetPrefs.js` enforces). */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/u
/** Reasoning-effort ids are provider-owned strings; keep them token-safe. */
const EFFORT_ID = /^[a-z0-9][a-z0-9._-]*$/iu
/** The grammar `/permission <preset>` accepts (isCommandCompletionToken). */
const PERMISSION_ID = /^[a-z0-9_.:/-]+$/iu
/** Reserved permission values that never seed a session. */
const RESERVED_PERMISSIONS = new Set(['auto', 'custom', 'status'])
/** Default poll interval for `pin` mode, in milliseconds. */
const DEFAULT_POLL_MS = 2000

/* ------------------------------------------------------------------ *
 * Paths
 * ------------------------------------------------------------------ */

/**
 * dsh-TUI's data directory, resolved exactly like `utils/paths.js` does.
 * @returns Absolute `~/.dsh-tui` path.
 */
export function resolveDataDir() {
  const home = homedir() || process.env.USERPROFILE || process.env.HOME || ''
  return join(home, '.dsh-tui')
}

/**
 * Test-only override of the data directory (`DSH_TUI_FAVORS_DIR`). The real
 * dsh-TUI never sets it; the verification script does.
 * @returns The override, if any.
 */
function dataDir() {
  const override = process.env.DSH_TUI_FAVORS_DIR
  return typeof override === 'string' && override !== '' ? override : resolveDataDir()
}

/* ------------------------------------------------------------------ *
 * Config
 * ------------------------------------------------------------------ */

/**
 * Whether a value is a printable, non-empty token (no control characters).
 * @param value - Candidate string.
 * @returns True when usable.
 */
function isSafeText(value) {
  return typeof value === 'string' && value !== '' && value.length <= 512 && !/[\x00-\x1f\x7f-\x9f]/u.test(value)
}

/**
 * Validate and normalize the row config. Never throws: a bad value is dropped
 * with one human-readable problem line, so a typo in `cordis.patch.yml` cannot
 * break the boot or write junk into a preference file.
 * @param input - Raw row config from the composition.
 * @returns `{ enabled, pin, pollMs, favorites, problems }`.
 */
export function resolveConfig(input) {
  const raw = input !== null && typeof input === 'object' && !Array.isArray(input) ? input : {}
  /** @type {Record<string, unknown>} */
  const favorites = {}
  /** @type {string[]} */
  const problems = []

  const provider = typeof raw.provider === 'string' ? raw.provider.trim() : undefined
  const model = typeof raw.model === 'string' ? raw.model.trim() : undefined
  if (provider !== undefined || model !== undefined) {
    if (!isSafeText(provider) || !isSafeText(model)) {
      problems.push('model: `provider` and `model` must both be filled in (a half route is never written)')
    } else {
      favorites.model = { provider, model }
    }
  }

  const effort = typeof raw.effort === 'string' ? raw.effort.trim() : undefined
  if (effort !== undefined) {
    if (!EFFORT_ID.test(effort)) problems.push(`effort: "${effort}" is not a tier id (letters, digits, dot, underscore, dash)`)
    else favorites.effort = effort
  }

  const preset = typeof raw.preset === 'string' ? raw.preset.trim() : undefined
  if (preset !== undefined) {
    if (!PRESET_ID.test(preset)) problems.push(`preset: "${preset}" is not a preset id (lowercase, digits, dash)`)
    else favorites.preset = preset
  }

  const permission = typeof raw.permission === 'string' ? raw.permission.trim() : undefined
  if (permission !== undefined) {
    if (!PERMISSION_ID.test(permission)) problems.push(`permission: "${permission}" is not a command token`)
    else if (RESERVED_PERMISSIONS.has(permission)) problems.push(`permission: "${permission}" is session-only and never seeds a conversation`)
    else favorites.permission = permission
  }

  const pin = raw.pin !== false
  const pollRaw = Number(raw.pollMs)
  const pollMs = Number.isFinite(pollRaw) ? Math.max(250, Math.round(pollRaw)) : DEFAULT_POLL_MS

  return { enabled: raw.enabled !== false, pin, pollMs, favorites, problems }
}

/* ------------------------------------------------------------------ *
 * Preference files
 * ------------------------------------------------------------------ */

/**
 * Read one preference file and reduce it to the value this plugin compares.
 * @param dir - Data directory.
 * @param knob - Which knob to read.
 * @returns The canonical value, or undefined when missing/corrupt.
 */
export function readPref(dir, knob) {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, PREF_FILES[knob]), 'utf8'))
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    if (knob === 'model') {
      const { provider, model } = parsed
      return typeof provider === 'string' && provider !== '' && typeof model === 'string' && model !== ''
        ? { provider, model }
        : undefined
    }
    const value = parsed[knob]
    return typeof value === 'string' && value !== '' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether two preference values are the same choice.
 * @param knob - Which knob.
 * @param left - Current value.
 * @param right - Desired value.
 * @returns True when nothing has to be written.
 */
function samePref(knob, left, right) {
  if (left === undefined || right === undefined) return left === right
  if (knob === 'model') return left.provider === right.provider && left.model === right.model
  return left === right
}

/**
 * The exact JSON payload dsh-TUI's own preference writers produce.
 * @param knob - Which knob.
 * @param value - The pinned value.
 * @returns The file content object.
 */
function prefPayload(knob, value) {
  return knob === 'model' ? { provider: value.provider, model: value.model } : { [knob]: value }
}

/**
 * Write one preference file atomically (temp + rename) so a reader never sees a
 * half-written JSON document.
 * @param dir - Data directory.
 * @param knob - Which knob.
 * @param value - The pinned value.
 */
function writePref(dir, knob, value) {
  mkdirSync(dir, { recursive: true })
  const target = join(dir, PREF_FILES[knob])
  const temporary = join(dir, `.${PREF_FILES[knob]}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(temporary, JSON.stringify(prefPayload(knob, value), null, 2))
    renameSync(temporary, target)
  } catch (error) {
    try {
      rmSync(temporary, { force: true })
    } catch {
      // A leftover temp file is preferable to losing the original error.
    }
    throw error
  }
}

/**
 * Re-assert every configured favorite, writing only the files that differ.
 * @param favorites - Validated favorites.
 * @param dir - Data directory.
 * @returns `{ written, kept, failed }` knob lists.
 */
export function applyFavorites(favorites, dir = dataDir()) {
  const written = []
  const kept = []
  const failed = []
  for (const knob of KNOBS) {
    const desired = favorites[knob]
    if (desired === undefined) continue
    try {
      if (samePref(knob, readPref(dir, knob), desired)) {
        kept.push(knob)
        continue
      }
      writePref(dir, knob, desired)
      written.push(knob)
    } catch {
      failed.push(knob)
    }
  }
  return { written, kept, failed }
}

/* ------------------------------------------------------------------ *
 * Reporting
 * ------------------------------------------------------------------ */

/**
 * Precedence notices: the deployment can outrank a preference file, and the
 * user deserves to know rather than wonder why a favorite "does not stick".
 * @param favorites - Validated favorites.
 * @returns Warning lines for the status report.
 */
function precedenceNotes(favorites) {
  const notes = []
  if (favorites.preset !== undefined && (process.env.DSH_TUI_PRESET ?? '').trim() !== '') {
    notes.push(`DSH_TUI_PRESET=${process.env.DSH_TUI_PRESET} overrides the pinned preset for this launch`)
  }
  if (favorites.permission !== undefined && (process.env.DSH_PERMISSION_MODE ?? '').trim() !== '') {
    notes.push(`DSH_PERMISSION_MODE=${process.env.DSH_PERMISSION_MODE} overrides the pinned permission mode`)
  }
  if (favorites.effort !== undefined) {
    const settingsEffort = readSettingsEffortDefault()
    if (settingsEffort !== undefined) {
      notes.push(`/settings default reasoning effort ("${settingsEffort}") outranks the pinned effort`)
    }
  }
  return notes
}

/**
 * The dsh-tui settings user-layer `effortDefault`, when the user set one. Read
 * from `settings.json` directly: it outranks `effort.json`, so a pinned effort
 * silently loses unless the report says so.
 * @returns The configured level, if any.
 */
function readSettingsEffortDefault() {
  try {
    const parsed = JSON.parse(readFileSync(join(dataDir(), 'settings.json'), 'utf8'))
    const value = parsed?.values?.effortDefault
    return typeof value === 'string' && value !== '' && value !== 'auto' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * One preference line: what the file holds now and whether it matches.
 * @param dir - Data directory.
 * @param knob - Which knob.
 * @param desired - Pinned value.
 * @returns Rendered line.
 */
function knobLine(dir, knob, desired) {
  const current = readPref(dir, knob)
  const show = (value) => {
    if (value === undefined) return '—'
    return knob === 'model' ? `${value.provider}/${value.model}` : String(value)
  }
  if (desired === undefined) return `${knob}: not pinned (file: ${show(current)})`
  const state = samePref(knob, current, desired) ? 'pinned' : 'differs — restored on the next check'
  return `${knob}: ${show(desired)} (${state})`
}

/**
 * Build the `/favors` report.
 * @param options - Report inputs.
 * @returns Multi-line plain text.
 */
export function renderStatus({ config, dir, running }) {
  const lines = []
  const favorites = config.favorites
  const pinned = KNOBS.filter(knob => favorites[knob] !== undefined)
  if (!config.enabled) {
    lines.push('dsh-tui-favors: disabled in the profile config (writes nothing).')
    return lines.join('\n')
  }
  if (pinned.length === 0) {
    lines.push('dsh-tui-favors: no favorites configured — dsh-TUI keeps its own remembered preferences.')
    lines.push('Set provider/model, effort, preset and/or permission on the `dsh-tui-favors` row in the profile cordis.patch.yml.')
    return lines.join('\n')
  }
  lines.push(`dsh-tui-favors: ${pinned.join(' · ')} · mode ${config.pin ? `pin (${config.pollMs} ms)` : 'startup'}${running ? '' : ' · poll stopped'}`)
  for (const knob of KNOBS) lines.push('  ' + knobLine(dir, knob, favorites[knob]))
  lines.push(`  files: ${dir}`)
  for (const note of precedenceNotes(favorites)) lines.push('  note: ' + note)
  for (const problem of config.problems) lines.push('  config: ' + problem)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * Plugin body
 * ------------------------------------------------------------------ */

/**
 * Mount the plugin: write the favorites once (before dsh-TUI resolves the boot
 * route) and keep them pinned while the TUI runs.
 * @param ctx - Host Cordis context of this row.
 * @param input - Raw row config.
 */
export function apply(ctx, input) {
  let config
  try {
    config = resolveConfig(input)
  } catch {
    config = resolveConfig({})
  }

  const info = (message) => {
    try {
      ctx.logger?.info?.(`[dsh-tui-favors] ${message}`)
    } catch {
      // Logging is advisory; the favorites still apply.
    }
  }

  if (!config.enabled) {
    info('disabled by config; nothing pinned')
    return
  }

  const dir = dataDir()

  /** Last reported failure signature, so a broken data dir logs once. */
  let lastFailure
  const warnFailed = (failed) => {
    const signature = failed.join(',')
    if (signature === lastFailure) return
    lastFailure = signature
    info(`could not write ${failed.join(', ')} under ${dir} — dsh-TUI keeps its own preference`)
  }

  /**
   * Re-assert the favorites, reporting only changes.
   * @returns The applied/kept/failed lists.
   */
  const reconcile = () => {
    let result
    try {
      result = applyFavorites(config.favorites, dir)
    } catch {
      return { written: [], kept: [], failed: [] }
    }
    if (result.written.length > 0) info(`pinned ${result.written.join(', ')}`)
    if (result.failed.length > 0) warnFailed(result.failed)
    return result
  }

  // The boot write must stay synchronous: dsh-TUI's runtime row waits for this
  // loader tree to settle before it reads the same files for its first session.
  const first = reconcile()
  if (first.written.length === 0 && first.failed.length === 0) {
    info(`favorites already in place (${Object.keys(config.favorites).join(', ') || 'none'})`)
  }

  if (config.pin && Object.keys(config.favorites).length > 0) {
    ctx.effect(() => {
      const timer = setInterval(reconcile, config.pollMs)
      timer.unref?.()
      return () => clearInterval(timer)
    })
  }

  ctx.inject(['commands'], (commandCtx) => {
    try {
      commandCtx.commands.register({
        name: 'favors',
        description: 'Show the pinned model/effort/preset/permission and re-apply them',
        input: { hint: 'status | apply' },
        handler: async (invocation) => {
          const argument = String(invocation.rawInput ?? '').trim()
          if (argument === 'apply') {
            const result = applyFavorites(config.favorites, dir)
            const parts = []
            if (result.written.length > 0) parts.push(`wrote ${result.written.join(', ')}`)
            if (result.kept.length > 0) parts.push(`already in place: ${result.kept.join(', ')}`)
            if (result.failed.length > 0) parts.push(`failed: ${result.failed.join(', ')}`)
            return {
              kind: result.failed.length > 0 ? 'error' : 'success',
              text: `dsh-tui-favors: ${parts.join('; ') || 'nothing configured'}`,
            }
          }
          if (argument !== '' && argument !== 'status') {
            return { kind: 'error', text: 'dsh-tui-favors: usage — /favors [status|apply]' }
          }
          return { kind: 'success', text: renderStatus({ config, dir, running: config.pin }) }
        },
      })
    } catch (error) {
      info(`the /favors command could not be registered (${error instanceof Error ? error.message : String(error)})`)
    }
  })
}
