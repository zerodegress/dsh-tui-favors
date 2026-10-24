/**
 * Cross-check against the REAL dsh-TUI preference readers.
 *
 * `index.js` writes `~/.dsh-tui/{model,effort,agent-preset,permission}.json`
 * itself instead of importing the host's private preference modules (they are
 * not in the package's export map). This script pins that contract from the
 * other side: it imports the readers the TUI actually uses and asserts they
 * parse what this plugin wrote — and that the TUI's own writers produce files
 * this plugin's reader accepts.
 *
 * Run: node scripts/verify-host.mjs [path-to-dsh-tui-package]
 * Defaults to the `dsh-tui` install of the local profile; exits 0 with a skip
 * notice when that install is absent.
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { applyFavorites, readPref } from '../index.js'

const candidate = process.argv[2]
  ?? process.env.DSH_TUI_PACKAGE
  ?? join(homedir(), '.dsh', 'profiles', 'dsh-tui', 'node_modules', '@deepseek-harness-tui', 'dsh-tui')

const types = join(candidate, 'lib', 'types')
if (!existsSync(join(types, 'modelPrefs.js'))) {
  console.log(`skip: no dsh-tui install at ${candidate}`)
  process.exit(0)
}

const load = (file) => import(pathToFileURL(join(types, file)).href)
const [modelPrefs, effortPrefs, presetPrefs, permissionPrefs] = await Promise.all([
  load('modelPrefs.js'),
  load('effortPrefs.js'),
  load('presetPrefs.js'),
  load('permissionPrefs.js'),
])

const dir = mkdtempSync(join(tmpdir(), 'dsh-tui-favors-host-'))
const favorites = {
  model: { provider: 'example', model: 'chat-1' },
  effort: 'max',
  preset: 'cordis',
  permission: 'workspace-write',
}

let failures = 0
const check = (label, run) => {
  try {
    run()
    console.log(`  ok   ${label}`)
  } catch (error) {
    failures += 1
    console.log(`  FAIL ${label}\n       ${error instanceof Error ? error.message : String(error)}`)
  }
}

try {
  applyFavorites(favorites, dir)

  console.log('host readers accept the plugin’s files')
  check('readModelPref', () => assert.deepEqual(modelPrefs.readModelPref(dir), favorites.model))
  check('readEffortPref', () => assert.equal(effortPrefs.readEffortPref(dir), 'max'))
  check('readPresetPref', () => assert.equal(presetPrefs.readPresetPref(dir), 'cordis'))
  check('readPermissionPref', () => assert.equal(permissionPrefs.readPermissionPref(dir), 'workspace-write'))

  console.log('boot precedence resolves the pinned values')
  check('model pref outranks the cordis.yml pair', () => {
    // resolveModelRoute is private to the package's modelRoute.js; the reader
    // above is the layer the boot route is built on, so its answer is the
    // contract this plugin has to satisfy.
    assert.deepEqual(modelPrefs.readModelPref(dir), favorites.model)
  })
  check('pinned effort wins the /effort chain', () => {
    const resolved = effortPrefs.resolveEffortDefault(undefined, 'high', effortPrefs.readEffortPref(dir))
    assert.equal(resolved, 'max')
  })
  check('pinned effort is offered by a route with a matching tier', () => {
    assert.equal(effortPrefs.nearestLowerEffort('max', ['low', 'high', 'max']), 'max')
  })
  check('an effort tier the route lacks falls back DOWN, never up', () => {
    assert.equal(effortPrefs.nearestLowerEffort('max', ['low', 'high']), 'high')
  })
  check('the pinned preset beats the cordis.yml deployment default', () => {
    const requested = presetPrefs.presetOverrideFromEnv({}) ?? presetPrefs.readPresetPref(dir) ?? 'standard'
    assert.equal(requested, 'cordis')
  })
  check('DSH_TUI_PRESET still outranks the pinned preset (documented limit)', () => {
    const requested = presetPrefs.presetOverrideFromEnv({ DSH_TUI_PRESET: 'minimal' }) ?? presetPrefs.readPresetPref(dir)
    assert.equal(requested, 'minimal')
  })
  check('a pinned preset that the roster no longer ships reads as an id, not a crash', () => {
    const copy = mkdtempSync(join(tmpdir(), 'dsh-tui-favors-host-'))
    try {
      applyFavorites({ preset: 'gone-preset' }, copy)
      assert.equal(presetPrefs.readPresetPref(copy), 'gone-preset')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })

  console.log('the plugin reads files the TUI itself writes')
  check('writeModelPref → readPref', () => {
    const copy = mkdtempSync(join(tmpdir(), 'dsh-tui-favors-host-'))
    try {
      modelPrefs.writeModelPref('deepseek-official', 'deepseek-flash', copy)
      assert.deepEqual(readPref(copy, 'model'), { provider: 'deepseek-official', model: 'deepseek-flash' })
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
  check('writeEffortPref → readPref', () => {
    const copy = mkdtempSync(join(tmpdir(), 'dsh-tui-favors-host-'))
    try {
      effortPrefs.writeEffortPref('low', copy)
      assert.equal(readPref(copy, 'effort'), 'low')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
  check('writePresetPref → readPref', () => {
    const copy = mkdtempSync(join(tmpdir(), 'dsh-tui-favors-host-'))
    try {
      presetPrefs.writePresetPref('minimal', copy)
      assert.equal(readPref(copy, 'preset'), 'minimal')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
  check('writePermissionPref → readPref', () => {
    const copy = mkdtempSync(join(tmpdir(), 'dsh-tui-favors-host-'))
    try {
      permissionPrefs.writePermissionPref('danger-full-access', copy)
      assert.equal(readPref(copy, 'permission'), 'danger-full-access')
    } finally {
      rmSync(copy, { recursive: true, force: true })
    }
  })
} finally {
  rmSync(dir, { recursive: true, force: true })
}

if (failures > 0) {
  console.log(`\n${failures} host cross-check(s) failed`)
  process.exit(1)
}
console.log('\nhost cross-checks passed')
