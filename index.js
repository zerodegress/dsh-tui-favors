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
 * Configuration comes in two layers with the same shape: this row's `config`
 * in the profile's `cordis.patch.yml`, and an optional
 * `~/.dsh-tui/favors.json` — flat JSON carrying the same keys — that outranks
 * it knob by knob. The file is re-read on every `pin` check, so a user can try
 * another route without editing the profile or restarting; only values that
 * survive validation override anything, and `enabled: false` on the row is a
 * kill switch that stops the file from being read at all.
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
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'

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
/** User-owned favorites file, read on top of the row config (`~/.dsh-tui/favors.json`). */
const FAVORS_FILE = 'favors.json'
/** A pathological favorites file is refused instead of parsed. */
const MAX_FILE_BYTES = 64 * 1024
/** Keys the row — and therefore the favorites file — understands. */
const KNOWN_KEYS = ['enabled', 'provider', 'model', 'effort', 'preset', 'permission', 'pin', 'pollMs']
/** Keys a JSON value must spell as a string; a number or `null` there is a typo. */
const STRING_KEYS = ['provider', 'model', 'effort', 'preset', 'permission']

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
 * Whether a value is a plain JSON-ish object (not null, not an array).
 * @param value - Candidate.
 * @returns True when it can carry keys.
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Interpret one knob out of a raw config object. The single parser shared by
 * the row config and the favorites file, so both layers accept exactly the
 * same values.
 * @param knob - Which knob to read.
 * @param raw - Raw config object.
 * @returns `undefined` when absent, `{ value }` when usable, `{ problem }` when present but unusable.
 */
function parseKnob(knob, raw) {
  switch (knob) {
    case 'model': {
      const provider = typeof raw.provider === 'string' ? raw.provider.trim() : undefined
      const model = typeof raw.model === 'string' ? raw.model.trim() : undefined
      if (provider === undefined && model === undefined) return undefined
      if (!isSafeText(provider) || !isSafeText(model)) {
        return { problem: 'model: `provider` and `model` must both be filled in (a half route is never written)' }
      }
      return { value: { provider, model } }
    }
    case 'effort': {
      const effort = typeof raw.effort === 'string' ? raw.effort.trim() : undefined
      if (effort === undefined) return undefined
      if (!EFFORT_ID.test(effort)) {
        return { problem: `effort: "${effort}" is not a tier id (letters, digits, dot, underscore, dash)` }
      }
      return { value: effort }
    }
    case 'preset': {
      const preset = typeof raw.preset === 'string' ? raw.preset.trim() : undefined
      if (preset === undefined) return undefined
      if (!PRESET_ID.test(preset)) return { problem: `preset: "${preset}" is not a preset id (lowercase, digits, dash)` }
      return { value: preset }
    }
    case 'permission': {
      const permission = typeof raw.permission === 'string' ? raw.permission.trim() : undefined
      if (permission === undefined) return undefined
      if (!PERMISSION_ID.test(permission)) return { problem: `permission: "${permission}" is not a command token` }
      if (RESERVED_PERMISSIONS.has(permission)) {
        return { problem: `permission: "${permission}" is session-only and never seeds a conversation` }
      }
      return { value: permission }
    }
    default:
      return undefined
  }
}

/**
 * Validate and normalize the row config. Never throws: a bad value is dropped
 * with one human-readable problem line, so a typo in `cordis.patch.yml` cannot
 * break the boot or write junk into a preference file.
 * @param input - Raw row config from the composition.
 * @returns `{ enabled, pin, pollMs, favorites, problems }`.
 */
export function resolveConfig(input) {
  const raw = isPlainObject(input) ? input : {}
  const favorites = {}
  const problems = []

  for (const knob of KNOBS) {
    const parsed = parseKnob(knob, raw)
    if (parsed === undefined) continue
    if (parsed.problem !== undefined) problems.push(parsed.problem)
    else favorites[knob] = parsed.value
  }

  const pin = raw.pin !== false
  const pollRaw = Number(raw.pollMs)
  const pollMs = Number.isFinite(pollRaw) ? Math.max(250, Math.round(pollRaw)) : DEFAULT_POLL_MS

  return { enabled: raw.enabled !== false, pin, pollMs, favorites, problems }
}

/* ------------------------------------------------------------------ *
 * The user's favorites file (`~/.dsh-tui/favors.json`)
 * ------------------------------------------------------------------ */

/**
 * Cheapest possible change detector for the favorites file: one `stat`, no
 * read, no parse. `pin` mode calls this on every check.
 * @param dir - Data directory.
 * @returns `missing`, `not-a-file`, or `<mtime>:<size>`.
 */
export function favorsStamp(dir = dataDir()) {
  try {
    const stat = statSync(join(dir, FAVORS_FILE))
    return stat.isFile() ? `${stat.mtimeMs}:${stat.size}` : 'not-a-file'
  } catch {
    return 'missing'
  }
}

/**
 * One-line reason out of an error, safe to put in a report line.
 * @param error - Thrown value.
 * @returns Trimmed, newline-free message.
 */
function shortMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/\s+/gu, ' ').trim().slice(0, 200)
}

/**
 * Read and validate `~/.dsh-tui/favors.json`. Never throws and never guesses:
 * a broken file is reported as a whole, and a knob whose value is unusable is
 * dropped with one problem line, so the caller falls back to the row config
 * instead of pinning half an intent.
 *
 * The file shape is the row's `config:` block, flat:
 * `{ "provider": "…", "model": "…", "effort": "max", "pin": true }`.
 * @param dir - Data directory.
 * @returns `{ path, stamp, state, applied, problems, keys, mtimeMs?, size? }`.
 */
export function readFavorsFile(dir = dataDir()) {
  const path = join(dir, FAVORS_FILE)
  const stamp = favorsStamp(dir)
  const absent = { path, stamp, state: 'missing', applied: {}, problems: [], keys: 0 }

  let stat
  try {
    stat = statSync(path)
  } catch {
    return absent
  }
  if (!stat.isFile()) {
    return { ...absent, state: 'invalid', problems: [`${FAVORS_FILE}: not a regular file — ignored`] }
  }
  if (stat.size > MAX_FILE_BYTES) {
    return {
      ...absent,
      state: 'invalid',
      size: stat.size,
      problems: [`${FAVORS_FILE}: ${stat.size} bytes exceeds the ${MAX_FILE_BYTES}-byte limit — ignored`],
    }
  }

  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    return { ...absent, state: 'invalid', problems: [`${FAVORS_FILE}: cannot be read (${shortMessage(error)}) — ignored`] }
  }

  const invalid = (problem) => ({ ...absent, state: 'invalid', problems: [`${FAVORS_FILE}: ${problem}`] })
  // A BOM is the one thing every Windows editor adds; tolerate it.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  if (body.trim() === '') return invalid('is empty — ignored')

  let root
  try {
    root = JSON.parse(body)
  } catch (error) {
    return invalid(`is not valid JSON (${shortMessage(error)}) — ignored`)
  }
  if (!isPlainObject(root)) {
    const shape = Array.isArray(root) ? 'an array' : root === null ? 'null' : typeof root
    return invalid(`the root must be a JSON object (got ${shape}) — ignored`)
  }
  // The most likely copy/paste mistake: the whole cordis.patch.yml row instead
  // of just its `config:` block. Say that, rather than "unknown key: config".
  if (isPlainObject(root.config)) {
    return invalid('wraps the values in a `config` object — keep only the keys inside it')
  }

  const values = {}
  const problems = []
  for (const [key, value] of Object.entries(root)) {
    // `_comment`-style keys are the documented way to annotate strict JSON.
    if (key.startsWith('_')) continue
    if (!KNOWN_KEYS.includes(key)) {
      problems.push(`${FAVORS_FILE}: unknown key "${key}" (allowed: ${KNOWN_KEYS.join(', ')})`)
      continue
    }
    if (STRING_KEYS.includes(key) && typeof value !== 'string') {
      problems.push(`${FAVORS_FILE}: "${key}" must be a string — ignored`)
      continue
    }
    values[key] = value
  }

  const applied = {}
  for (const knob of KNOBS) {
    const parsed = parseKnob(knob, values)
    if (parsed === undefined) continue
    if (parsed.problem !== undefined) problems.push(`${FAVORS_FILE}: ${parsed.problem} — ignored`)
    else applied[knob] = parsed.value
  }
  for (const key of ['enabled', 'pin']) {
    if (!(key in values)) continue
    if (typeof values[key] === 'boolean') applied[key] = values[key]
    else problems.push(`${FAVORS_FILE}: "${key}" must be true or false — ignored`)
  }
  if ('pollMs' in values) {
    if (typeof values.pollMs === 'number' && Number.isFinite(values.pollMs)) {
      applied.pollMs = Math.max(250, Math.round(values.pollMs))
    } else {
      problems.push(`${FAVORS_FILE}: "pollMs" must be a number — ignored`)
    }
  }

  return {
    path,
    stamp,
    state: 'ok',
    applied,
    problems,
    keys: Object.keys(values).length,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
  }
}

/**
 * Resolve the effective config: the favorites file wins knob by knob over the
 * row config, which wins over the built-in defaults. Only values that survive
 * validation override anything — a typo falls back to the row instead of
 * silently un-pinning a knob.
 * @param rowInput - Raw row config from the composition.
 * @param dir - Data directory.
 * @returns `{ config, sources, file }`; `sources` maps `enabled`/knobs to the layer that supplied them.
 */
export function loadConfig(rowInput, dir = dataDir()) {
  const row = isPlainObject(rowInput) ? rowInput : {}
  let file
  try {
    file = readFavorsFile(dir)
  } catch {
    file = { path: join(dir, FAVORS_FILE), stamp: 'missing', state: 'missing', applied: {}, problems: [], keys: 0 }
  }
  const fromRow = resolveConfig(row)

  const favorites = {}
  const sources = {}
  for (const knob of KNOBS) {
    if (file.applied[knob] !== undefined) {
      favorites[knob] = file.applied[knob]
      sources[knob] = FAVORS_FILE
    } else if (fromRow.favorites[knob] !== undefined) {
      favorites[knob] = fromRow.favorites[knob]
      sources[knob] = 'profile row'
    }
  }
  sources.enabled = file.applied.enabled === undefined ? 'profile row' : FAVORS_FILE

  const config = {
    enabled: file.applied.enabled ?? fromRow.enabled,
    pin: file.applied.pin ?? fromRow.pin,
    pollMs: file.applied.pollMs ?? fromRow.pollMs,
    favorites,
    problems: [...fromRow.problems, ...file.problems],
  }
  return { config, sources, file }
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
 * @param source - Which layer supplied the pinned value, if any.
 * @returns Rendered line.
 */
function knobLine(dir, knob, desired, source) {
  const current = readPref(dir, knob)
  const show = (value) => {
    if (value === undefined) return '—'
    return knob === 'model' ? `${value.provider}/${value.model}` : String(value)
  }
  if (desired === undefined) return `${knob}: not pinned (file: ${show(current)})`
  const state = samePref(knob, current, desired) ? 'pinned' : 'differs — restored on the next check'
  const tag = source === undefined ? '' : ` [${source}]`
  return `${knob}: ${show(desired)} (${state})${tag}`
}

/**
 * One line telling the reader which config layers were in play.
 * @param file - Result of `readFavorsFile`.
 * @returns Rendered line, or undefined when the caller has no file information.
 */
function describeFile(file) {
  if (file === undefined) return undefined
  if (file.state === 'missing') return `no ${FAVORS_FILE} — using the profile row`
  if (file.state === 'invalid') return `${FAVORS_FILE} ignored (see config lines) — using the profile row`
  const count = `${file.keys} key${file.keys === 1 ? '' : 's'}`
  const when = Number.isFinite(file.mtimeMs) ? `, mtime ${new Date(file.mtimeMs).toISOString()}` : ''
  return `${FAVORS_FILE} (${count}${when}) > profile row`
}

/**
 * Build the `/favors` report.
 * @param options - Report inputs.
 * @returns Multi-line plain text.
 */
export function renderStatus({ config, dir, running, sources = {}, file }) {
  const lines = []
  const favorites = config.favorites
  const pinned = KNOBS.filter(knob => favorites[knob] !== undefined)
  if (!config.enabled) {
    const where = sources.enabled === FAVORS_FILE ? ` by ${FAVORS_FILE}` : ' in the profile config'
    lines.push(`dsh-tui-favors: disabled${where} (writes nothing).`)
    return lines.join('\n')
  }
  if (pinned.length === 0) {
    lines.push('dsh-tui-favors: no favorites configured — dsh-TUI keeps its own remembered preferences.')
    lines.push('Set provider/model, effort, preset and/or permission on the `dsh-tui-favors` row in the profile cordis.patch.yml,')
    lines.push(`or in ${join(dir, FAVORS_FILE)} — that file outranks the row and applies without a restart.`)
    return lines.join('\n')
  }
  lines.push(`dsh-tui-favors: ${pinned.join(' · ')} · mode ${config.pin ? `pin (${config.pollMs} ms)` : 'startup'}${running ? '' : ' · poll stopped'}`)
  for (const knob of KNOBS) lines.push('  ' + knobLine(dir, knob, favorites[knob], sources[knob]))
  lines.push(`  files: ${dir}`)
  const described = describeFile(file)
  if (described !== undefined) lines.push(`  source: ${described}`)
  for (const note of precedenceNotes(favorites)) lines.push('  note: ' + note)
  for (const problem of config.problems) lines.push('  config: ' + problem)
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * Plugin body
 * ------------------------------------------------------------------ */

/**
 * Mount the plugin: write the favorites once (before dsh-TUI resolves the boot
 * route) and keep them pinned while the TUI runs. `~/.dsh-tui/favors.json`
 * outranks the row config and is re-read when it changes.
 * @param ctx - Host Cordis context of this row.
 * @param input - Raw row config.
 */
export function apply(ctx, input) {
  let row
  try {
    row = isPlainObject(input) ? input : {}
  } catch {
    row = {}
  }

  const info = (message) => {
    try {
      ctx.logger?.info?.(`[dsh-tui-favors] ${message}`)
    } catch {
      // Logging is advisory; the favorites still apply.
    }
  }

  // The row's `enabled: false` is a deployment-level kill switch: a user file
  // must not resurrect a plugin the deployment turned off, so it is not read.
  if (row.enabled === false) {
    info(`disabled by the profile row; ${FAVORS_FILE} is not read`)
    return
  }

  const dir = dataDir()

  let loaded
  try {
    loaded = loadConfig(row, dir)
  } catch {
    loaded = {
      config: resolveConfig(row),
      sources: {},
      file: { path: join(dir, FAVORS_FILE), stamp: 'missing', state: 'missing', applied: {}, problems: [], keys: 0 },
    }
  }

  /** Problems already logged, so a bad file does not log on every check. */
  const reported = new Set()
  const reportProblems = () => {
    for (const problem of loaded.config.problems) {
      if (reported.has(problem)) continue
      reported.add(problem)
      info(problem)
    }
  }
  reportProblems()

  /**
   * Re-read the favorites file when it changed. One `stat` when it did not, so
   * editing the JSON applies without a restart.
   * @returns True when the config was reloaded.
   */
  const refresh = () => {
    try {
      if (favorsStamp(dir) === loaded.file.stamp) return false
      loaded = loadConfig(row, dir)
      reportProblems()
      info(`${FAVORS_FILE} reloaded (${Object.keys(loaded.config.favorites).length} pinned)`)
      return true
    } catch {
      return false
    }
  }

  /** Last reported failure signature, so a broken data dir logs once. */
  let lastFailure
  const warnFailed = (failed) => {
    const signature = failed.join(',')
    if (signature === lastFailure) return
    lastFailure = signature
    info(`could not write ${failed.join(', ')} under ${dir} — dsh-TUI keeps its own preference`)
  }

  /** Whether the "writes nothing" notice was already logged. */
  let disabledLogged = false

  /**
   * Re-assert every configured favorite once, reporting only changes. Honours
   * `enabled` but not `pin`: this is also the boot write, which happens once
   * even when `pin` is off.
   * @returns `{ written, kept, failed }` knob lists.
   */
  const writeOnce = () => {
    const config = loaded.config
    if (!config.enabled) {
      if (!disabledLogged) {
        disabledLogged = true
        info(`disabled by ${loaded.sources.enabled === FAVORS_FILE ? FAVORS_FILE : 'the profile row'}; nothing pinned`)
      }
      return { written: [], kept: [], failed: [] }
    }
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

  /**
   * The `pin` check: pick up a changed favorites file, then restore drift.
   * @returns `{ written, kept, failed }` knob lists.
   */
  const tick = () => {
    refresh()
    if (!loaded.config.pin) return { written: [], kept: [], failed: [] }
    return writeOnce()
  }

  // The boot write must stay synchronous: dsh-TUI's runtime row waits for this
  // loader tree to settle before it reads the same files for its first session.
  const first = writeOnce()
  if (first.written.length === 0 && first.failed.length === 0 && loaded.config.enabled) {
    info(`favorites already in place (${Object.keys(loaded.config.favorites).join(', ') || 'none'})`)
  }

  if (loaded.config.pin && Object.keys(loaded.config.favorites).length > 0) {
    ctx.effect(() => {
      const timer = setInterval(tick, loaded.config.pollMs)
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
            refresh()
            const result = writeOnce()
            const parts = []
            if (result.written.length > 0) parts.push(`wrote ${result.written.join(', ')}`)
            if (result.kept.length > 0) parts.push(`already in place: ${result.kept.join(', ')}`)
            if (result.failed.length > 0) parts.push(`failed: ${result.failed.join(', ')}`)
            const text = loaded.config.enabled
              ? parts.join('; ') || 'nothing configured'
              : `disabled by ${loaded.sources.enabled === FAVORS_FILE ? FAVORS_FILE : 'the profile row'}`
            return {
              kind: result.failed.length > 0 ? 'error' : 'success',
              text: `dsh-tui-favors: ${text}`,
            }
          }
          if (argument !== '' && argument !== 'status') {
            return { kind: 'error', text: 'dsh-tui-favors: usage — /favors [status|apply]' }
          }
          refresh()
          return {
            kind: 'success',
            text: renderStatus({
              config: loaded.config,
              dir,
              running: loaded.config.pin,
              sources: loaded.sources,
              file: loaded.file,
            }),
          }
        },
      })
    } catch (error) {
      info(`the /favors command could not be registered (${error instanceof Error ? error.message : String(error)})`)
    }
  })
}
