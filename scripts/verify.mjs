/**
 * Offline verification for dsh-tui-favors. No host, no TUI: it drives the
 * module's exported surface against a temporary data directory and asserts the
 * exact JSON shapes dsh-TUI's own readers (`modelPrefs.js`, `effortPrefs.js`,
 * `presetPrefs.js`, `permissionPrefs.js`) parse.
 *
 * Run: node scripts/verify.mjs
 */
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, applyFavorites, loadConfig, readPref, renderStatus, resolveConfig } from '../index.js'

let failures = 0
const test = (label, run) => {
  try {
    run()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}
const group = (label) => console.log(`\n${label}`)

const freshDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-favors-'))
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) }
}

/* ------------------------------------------------------------------ */
group('resolveConfig')

test('keeps a complete model pair and drops a half route', () => {
  assert.deepEqual(resolveConfig({ provider: 'example', model: 'chat-1' }).favorites.model, { provider: 'example', model: 'chat-1' })
  const half = resolveConfig({ provider: 'example' })
  assert.equal(half.favorites.model, undefined)
  assert.equal(half.problems.length, 1)
})

test('validates preset ids against the presetPrefs boundary', () => {
  assert.equal(resolveConfig({ preset: 'cordis' }).favorites.preset, 'cordis')
  assert.equal(resolveConfig({ preset: 'Cordis' }).favorites.preset, undefined)
  assert.equal(resolveConfig({ preset: 'my-p1' }).favorites.preset, 'my-p1')
})

test('refuses session-only permission values and junk tokens', () => {
  for (const value of ['auto', 'custom', 'status']) {
    assert.equal(resolveConfig({ permission: value }).favorites.permission, undefined, value)
  }
  assert.equal(resolveConfig({ permission: 'workspace-write' }).favorites.permission, 'workspace-write')
  assert.equal(resolveConfig({ permission: 'danger-full-access' }).favorites.permission, 'danger-full-access')
  assert.equal(resolveConfig({ permission: 'bad value' }).favorites.permission, undefined)
})

test('rejects control characters in effort and keeps the usual tiers', () => {
  assert.equal(resolveConfig({ effort: 'max' }).favorites.effort, 'max')
  assert.equal(resolveConfig({ effort: 'xhigh' }).favorites.effort, 'xhigh')
  assert.equal(resolveConfig({ effort: 'ma\nx' }).favorites.effort, undefined)
})

test('defaults: enabled, pin off, 2s poll; a bad pollMs falls back', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.pin, false)
  assert.equal(config.pollMs, 2000)
  assert.equal(resolveConfig({ pollMs: 5 }).pollMs, 250)
  assert.equal(resolveConfig({ pollMs: 'nope' }).pollMs, 2000)
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.equal(resolveConfig({ pin: true }).pin, true)
})

test('never throws on hostile input', () => {
  for (const input of [null, 42, 'x', [], { provider: 42, effort: null }]) {
    assert.doesNotThrow(() => resolveConfig(input))
  }
})

/* ------------------------------------------------------------------ */
group('applyFavorites (the files dsh-TUI reads)')

test('writes the exact payload dsh-TUI parses', () => {
  const { dir, dispose } = freshDir()
  try {
    const result = applyFavorites(
      { model: { provider: 'example', model: 'chat-1' }, effort: 'max', preset: 'cordis', permission: 'workspace-write' },
      dir,
    )
    assert.deepEqual(result.written.sort(), ['effort', 'model', 'permission', 'preset'])
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'model.json'), 'utf8')), { provider: 'example', model: 'chat-1' })
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'effort.json'), 'utf8')), { effort: 'max' })
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'agent-preset.json'), 'utf8')), { preset: 'cordis' })
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'permission.json'), 'utf8')), { permission: 'workspace-write' })
    // Round-trip through the reducer the host uses.
    assert.deepEqual(readPref(dir, 'model'), { provider: 'example', model: 'chat-1' })
    assert.equal(readPref(dir, 'effort'), 'max')
    assert.equal(readPref(dir, 'preset'), 'cordis')
    assert.equal(readPref(dir, 'permission'), 'workspace-write')
  } finally {
    dispose()
  }
})

test('second run is a no-op (kept, no rewrite)', () => {
  const { dir, dispose } = freshDir()
  try {
    const favorites = { model: { provider: 'a', model: 'b' }, effort: 'max' }
    applyFavorites(favorites, dir)
    const again = applyFavorites(favorites, dir)
    assert.deepEqual(again.written, [])
    assert.deepEqual(again.kept.sort(), ['effort', 'model'])
  } finally {
    dispose()
  }
})

test('only configured knobs are touched', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFileSync(join(dir, 'permission.json'), JSON.stringify({ permission: 'danger-full-access' }))
    applyFavorites({ effort: 'high' }, dir)
    assert.equal(readPref(dir, 'permission'), 'danger-full-access')
    assert.equal(readPref(dir, 'effort'), 'high')
    assert.equal(readPref(dir, 'preset'), undefined)
  } finally {
    dispose()
  }
})

test('restores a preference another writer changed (pin semantics)', () => {
  const { dir, dispose } = freshDir()
  try {
    const favorites = { model: { provider: 'example', model: 'chat-1' }, preset: 'cordis' }
    applyFavorites(favorites, dir)
    // dsh-TUI's `/model` and `/preset` pickers rewrite these files.
    writeFileSync(join(dir, 'model.json'), JSON.stringify({ provider: 'other', model: 'y' }))
    writeFileSync(join(dir, 'agent-preset.json'), JSON.stringify({ preset: 'minimal' }))
    const result = applyFavorites(favorites, dir)
    assert.deepEqual(result.written.sort(), ['model', 'preset'])
    assert.equal(readPref(dir, 'preset'), 'cordis')
    assert.deepEqual(readPref(dir, 'model'), { provider: 'example', model: 'chat-1' })
  } finally {
    dispose()
  }
})

test('a corrupt file reads as unset and is replaced', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFileSync(join(dir, 'effort.json'), '{ not json')
    assert.equal(applyFavorites({ effort: 'low' }, dir).written[0], 'effort')
    assert.equal(readPref(dir, 'effort'), 'low')
  } finally {
    dispose()
  }
})

test('a failed write is reported, not thrown', () => {
  const { dir, dispose } = freshDir()
  try {
    // A file where the directory should be makes mkdir fail.
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, 'x')
    const result = applyFavorites({ effort: 'max' }, join(blocked, 'nested'))
    assert.deepEqual(result.failed, ['effort'])
  } finally {
    dispose()
  }
})

/* ------------------------------------------------------------------ */
group('apply() / /favors wiring')

/** Minimal Cordis-shaped context: logger, effect, inject. */
const fakeContext = () => {
  const registered = []
  const effects = []
  const logs = []
  const ctx = {
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line), debug: () => {} },
    effect: (callback) => {
      effects.push(callback())
    },
    inject: (deps, callback) => {
      assert.deepEqual(deps, ['commands'])
      callback({
        commands: {
          register: (definition) => {
            registered.push(definition)
            return () => {}
          },
        },
      })
      return { then: () => {} }
    },
  }
  return { ctx, registered, effects, logs }
}

test('apply writes the favorites and registers /favors', () => {
  const { dir, dispose } = freshDir()
  const previous = process.env.DSH_TUI_FAVORS_DIR
  process.env.DSH_TUI_FAVORS_DIR = dir
  try {
    const { ctx, registered, effects, logs } = fakeContext()
    apply(ctx, { provider: 'example', model: 'chat-1', effort: 'max', preset: 'cordis', permission: 'workspace-write', pin: true, pollMs: 60000 })
    assert.equal(readPref(dir, 'effort'), 'max')
    assert.equal(readPref(dir, 'permission'), 'workspace-write')
    assert.equal(registered.length, 1)
    assert.equal(registered[0].name, 'favors')
    assert.equal(effects.length, 1, 'pin mode installs one interval effect')
    assert.ok(logs.some((line) => line.includes('pinned')))
    effects.forEach((disposeEffect) => disposeEffect())
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_FAVORS_DIR
    else process.env.DSH_TUI_FAVORS_DIR = previous
    dispose()
  }
})

test('pin:false installs no interval', () => {
  const { dir, dispose } = freshDir()
  const previous = process.env.DSH_TUI_FAVORS_DIR
  process.env.DSH_TUI_FAVORS_DIR = dir
  try {
    const { ctx, effects } = fakeContext()
    apply(ctx, { effort: 'low', pin: false })
    assert.equal(effects.length, 0)
    assert.equal(readPref(dir, 'effort'), 'low')
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_FAVORS_DIR
    else process.env.DSH_TUI_FAVORS_DIR = previous
    dispose()
  }
})

test('omitting pin (the default) still writes once at boot', () => {
  const { dir, dispose } = freshDir()
  const previous = process.env.DSH_TUI_FAVORS_DIR
  process.env.DSH_TUI_FAVORS_DIR = dir
  try {
    const { ctx, effects, logs } = fakeContext()
    apply(ctx, { effort: 'low' })
    assert.equal(effects.length, 0, 'no interval without an explicit pin:true')
    assert.equal(readPref(dir, 'effort'), 'low')
    assert.ok(logs.some((line) => line.includes('pinned')))
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_FAVORS_DIR
    else process.env.DSH_TUI_FAVORS_DIR = previous
    dispose()
  }
})

test('disabled rows write nothing and register no command', () => {
  const { dir, dispose } = freshDir()
  const previous = process.env.DSH_TUI_FAVORS_DIR
  process.env.DSH_TUI_FAVORS_DIR = dir
  try {
    const { ctx, registered, effects } = fakeContext()
    apply(ctx, { enabled: false, effort: 'max' })
    assert.equal(readPref(dir, 'effort'), undefined)
    assert.equal(registered.length, 0)
    assert.equal(effects.length, 0)
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_FAVORS_DIR
    else process.env.DSH_TUI_FAVORS_DIR = previous
    dispose()
  }
})

test('apply survives a missing commands service and a broken data dir', () => {
  const { ctx } = fakeContext()
  ctx.inject = () => ({ then: () => {} })
  const previous = process.env.DSH_TUI_FAVORS_DIR
  process.env.DSH_TUI_FAVORS_DIR = join(tmpdir(), 'dsh-tui-favors-does-not-exist', 'x')
  try {
    assert.doesNotThrow(() => apply(ctx, { effort: 'max', pin: false }))
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_FAVORS_DIR
    else process.env.DSH_TUI_FAVORS_DIR = previous
  }
})

/* ------------------------------------------------------------------ */
group('/favors report')

test('status lists pinned knobs and flags drift', () => {
  const { dir, dispose } = freshDir()
  try {
    const config = resolveConfig({ provider: 'example', model: 'chat-1', effort: 'max' })
    applyFavorites(config.favorites, dir)
    const text = renderStatus({ config, dir, running: true })
    assert.match(text, /model: example\/chat-1 \(pinned\)/)
    assert.match(text, /effort: max \(pinned\)/)
    assert.match(text, /preset: not pinned/)
    assert.match(text, /permission: not pinned/)
    // drift
    writeFileSync(join(dir, 'effort.json'), JSON.stringify({ effort: 'low' }))
    assert.match(renderStatus({ config, dir, running: true }), /effort: max \(differs/)
  } finally {
    dispose()
  }
})

test('status explains an empty config and a disabled row', () => {
  const { dir, dispose } = freshDir()
  try {
    assert.match(renderStatus({ config: resolveConfig({}), dir, running: true }), /no favorites configured/)
    assert.match(renderStatus({ config: resolveConfig({ enabled: false }), dir, running: false }), /disabled/)
  } finally {
    dispose()
  }
})

/* ------------------------------------------------------------------ */
group('favors.json overrides the row')

/** Point the plugin's data directory at `dir` for one run. */
const withDir = (dir, run) => {
  const previous = process.env.DSH_TUI_FAVORS_DIR
  process.env.DSH_TUI_FAVORS_DIR = dir
  try {
    return run()
  } finally {
    if (previous === undefined) delete process.env.DSH_TUI_FAVORS_DIR
    else process.env.DSH_TUI_FAVORS_DIR = previous
  }
}

const writeFavors = (dir, value) => writeFileSync(join(dir, 'favors.json'), typeof value === 'string' ? value : JSON.stringify(value))

test('a complete file wins knob by knob and is reported as the source', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFavors(dir, {
      provider: 'file-p',
      model: 'file-m',
      effort: 'high',
      preset: 'minimal',
      permission: 'read-only',
    })
    const { config, sources } = loadConfig(
      { provider: 'row-p', model: 'row-m', effort: 'low', preset: 'cordis', permission: 'workspace-write' },
      dir,
    )
    assert.deepEqual(config.favorites, {
      model: { provider: 'file-p', model: 'file-m' },
      effort: 'high',
      preset: 'minimal',
      permission: 'read-only',
    })
    for (const knob of ['model', 'effort', 'preset', 'permission']) assert.equal(sources[knob], 'favors.json', knob)
    assert.deepEqual(config.problems, [])
  } finally {
    dispose()
  }
})

test('a partial file leaves the other knobs on the row', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFavors(dir, { effort: 'low' })
    const { config, sources } = loadConfig({ provider: 'row-p', model: 'row-m', preset: 'cordis' }, dir)
    assert.equal(config.favorites.effort, 'low')
    assert.deepEqual(config.favorites.model, { provider: 'row-p', model: 'row-m' })
    assert.equal(config.favorites.preset, 'cordis')
    assert.equal(sources.effort, 'favors.json')
    assert.equal(sources.model, 'profile row')
  } finally {
    dispose()
  }
})

test('invalid JSON falls back to the row and says why', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFavors(dir, '{ oops')
    const { config, file } = loadConfig({ effort: 'max' }, dir)
    assert.equal(file.state, 'invalid')
    assert.equal(config.favorites.effort, 'max')
    assert.match(config.problems[0], /favors\.json: is not valid JSON/)
  } finally {
    dispose()
  }
})

test('a copy-pasted patch row is refused with a pointed message', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFavors(dir, { id: 'dsh-tui-favors', name: 'dsh-tui-favors', config: { effort: 'high' } })
    const { config, file } = loadConfig({ effort: 'max' }, dir)
    assert.equal(file.state, 'invalid')
    assert.equal(config.favorites.effort, 'max')
    assert.match(config.problems[0], /keep only the keys inside it/)
  } finally {
    dispose()
  }
})

test('unknown keys are reported without blocking the known ones', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFavors(dir, { effort: 'high', permision: 'workspace-write' })
    const { config } = loadConfig({}, dir)
    assert.equal(config.favorites.effort, 'high')
    assert.equal(config.problems.length, 1)
    assert.match(config.problems[0], /unknown key "permision"/)
  } finally {
    dispose()
  }
})

test('underscore keys are comments, not config', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFavors(dir, { _comment: 'my favorites', effort: 'high' })
    const { config } = loadConfig({}, dir)
    assert.deepEqual(config.problems, [])
    assert.equal(config.favorites.effort, 'high')
  } finally {
    dispose()
  }
})

test('a value of the wrong type is ignored and the row value survives', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFavors(dir, { effort: 42 })
    const { config, sources } = loadConfig({ effort: 'max' }, dir)
    assert.equal(config.favorites.effort, 'max')
    assert.equal(sources.effort, 'profile row')
    assert.match(config.problems[0], /"effort" must be a string/)
  } finally {
    dispose()
  }
})

test('a semantically invalid file value falls back to the row', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFavors(dir, { preset: 'Cordis' })
    const { config } = loadConfig({ preset: 'cordis' }, dir)
    assert.equal(config.favorites.preset, 'cordis')
    assert.match(config.problems[0], /not a preset id/)
  } finally {
    dispose()
  }
})

test('a half route in the file never overrides a complete one', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFavors(dir, { provider: 'file-p' })
    const { config } = loadConfig({ provider: 'row-p', model: 'row-m' }, dir)
    assert.deepEqual(config.favorites.model, { provider: 'row-p', model: 'row-m' })
    assert.match(config.problems[0], /must both be filled in/)
  } finally {
    dispose()
  }
})

test('a BOM parses; an oversized file is refused', () => {
  const { dir, dispose } = freshDir()
  try {
    writeFavors(dir, '\uFEFF' + JSON.stringify({ effort: 'high' }))
    assert.equal(loadConfig({}, dir).config.favorites.effort, 'high')
    writeFavors(dir, 'x'.repeat(70 * 1024))
    const big = loadConfig({ effort: 'max' }, dir)
    assert.equal(big.file.state, 'invalid')
    assert.equal(big.config.favorites.effort, 'max')
    assert.match(big.config.problems[0], /exceeds the 65536-byte limit/)
  } finally {
    dispose()
  }
})

test('enabled:false in the file stops the writes but keeps /favors usable', () => {
  const { dir, dispose } = freshDir()
  try {
    withDir(dir, () => {
      writeFavors(dir, { enabled: false, effort: 'max' })
      const { ctx, registered, logs } = fakeContext()
      apply(ctx, { effort: 'low', pin: false })
      assert.equal(readPref(dir, 'effort'), undefined)
      assert.equal(registered.length, 1)
      assert.ok(logs.some((line) => line.includes('disabled by favors.json')))
      const { config, sources, file } = loadConfig({ effort: 'low' }, dir)
      assert.match(renderStatus({ config, dir, running: false, sources, file }), /disabled by favors\.json/)
    })
  } finally {
    dispose()
  }
})

test('the row kill switch ignores the file entirely', () => {
  const { dir, dispose } = freshDir()
  try {
    withDir(dir, () => {
      writeFavors(dir, { effort: 'high' })
      const { ctx, registered, logs } = fakeContext()
      apply(ctx, { enabled: false, effort: 'low' })
      assert.equal(readPref(dir, 'effort'), undefined)
      assert.equal(registered.length, 0)
      assert.ok(logs.some((line) => line.includes('favors.json is not read')))
    })
  } finally {
    dispose()
  }
})

/* ------------------------------------------------------------------ */
group('favors.json hot reload')

/** Swap the real interval for a manually driven ticker. */
const manualTicker = () => {
  const timers = []
  const setIntervalOriginal = globalThis.setInterval
  const clearIntervalOriginal = globalThis.clearInterval
  globalThis.setInterval = (callback) => {
    timers.push(callback)
    return { unref() {} }
  }
  globalThis.clearInterval = () => {}
  return {
    tick: () => timers.forEach((timer) => timer()),
    restore: () => {
      globalThis.setInterval = setIntervalOriginal
      globalThis.clearInterval = clearIntervalOriginal
    },
  }
}

const asyncTest = async (label, run) => {
  try {
    await run()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

await asyncTest('a pin check picks up an edited file without a restart', () => {
  const { dir, dispose } = freshDir()
  const ticker = manualTicker()
  try {
    withDir(dir, () => {
      const { ctx, effects, logs } = fakeContext()
      apply(ctx, { effort: 'low', pin: true, pollMs: 60000 })
      assert.equal(readPref(dir, 'effort'), 'low')

      writeFavors(dir, { effort: 'high' })
      ticker.tick()
      assert.equal(readPref(dir, 'effort'), 'high')
      assert.ok(logs.some((line) => line.includes('favors.json reloaded')))

      writeFavors(dir, { effort: 'medium' })
      ticker.tick()
      assert.equal(readPref(dir, 'effort'), 'medium')

      // Deleting the file must fall back to the row on the next check.
      rmSync(join(dir, 'favors.json'))
      ticker.tick()
      assert.equal(readPref(dir, 'effort'), 'low')
      effects.forEach((disposeEffect) => disposeEffect())
    })
  } finally {
    ticker.restore()
    dispose()
  }
})

await asyncTest('/favors reflects a file edited after boot', async () => {
  const { dir, dispose } = freshDir()
  try {
    const result = await withDir(dir, () => {
      const { ctx, registered } = fakeContext()
      apply(ctx, { effort: 'low', pin: false })
      writeFavors(dir, { effort: 'high' })
      return registered[0].handler({ rawInput: '' })
    })
    assert.match(result.text, /effort: high \(differs — restored on the next check\) \[favors\.json\]/)
    assert.match(result.text, /source: favors\.json \(1 key/)
  } finally {
    dispose()
  }
})

/* ------------------------------------------------------------------ */
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
