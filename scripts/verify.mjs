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
import { apply, applyFavorites, readPref, renderStatus, resolveConfig } from '../index.js'

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

test('defaults: enabled, pin on, 2s poll; a bad pollMs falls back', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.enabled, true)
  assert.equal(config.pin, true)
  assert.equal(config.pollMs, 2000)
  assert.equal(resolveConfig({ pollMs: 5 }).pollMs, 250)
  assert.equal(resolveConfig({ pollMs: 'nope' }).pollMs, 2000)
  assert.equal(resolveConfig({ enabled: false }).enabled, false)
  assert.equal(resolveConfig({ pin: false }).pin, false)
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
    apply(ctx, { provider: 'example', model: 'chat-1', effort: 'max', preset: 'cordis', permission: 'workspace-write', pollMs: 60000 })
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
if (failures > 0) {
  console.log(`\n${failures} check(s) failed`)
  process.exit(1)
}
console.log('\nall checks passed')
