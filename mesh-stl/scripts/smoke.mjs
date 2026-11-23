#!/usr/bin/env node
/**
 * mesh-stl smoke test — works without a DSH host.
 * Checks: config detection, hint cards, generator catalog/preset filtering, dry-run plan.
 * Usage: node scripts/smoke.mjs [--full]
 *   --full  also runs one real generator into <project>/.cache/mesh-smoke (fcc-cell).
 */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/common.js'
import { catalogFamilies, loadRegistry, runFamily } from '../lib/generators.js'
import { loadHints, searchHints } from '../lib/hints.js'

const full = process.argv.includes('--full')
const fail = (message) => { console.error(`FAIL ${message}`); process.exitCode = 1 }

const config = normalizeConfig({})
console.log(`project root : ${config.projectRoot || '(not detected)'}`)
console.log(`python       : ${config.python || '(not detected)'}`)
console.log(`configured   : ${config.configured}`)
if (!config.configured) {
  fail('project not detected — run from inside Mesh_3D_pore_scale or set MESH_STL_PROJECT_ROOT')
  process.exit(1)
}

const dataDir = join(config.packageRoot, 'data')
const hints = loadHints(join(dataDir, 'hints'))
assert.ok(hints.cards.length >= 10, `expected hint cards, got ${hints.cards.length}`)
assert.equal(hints.errors.length, 0, `hint load errors: ${JSON.stringify(hints.errors)}`)
console.log(`hints        : ${hints.cards.length} cards from ${hints.files.length} files`)

const search = searchHints(hints.cards, 'minVol layers', 3)
assert.ok(search.matches.length > 0, 'search returned nothing')
console.log(`search       : ${search.matches.map((r) => `${r.id}(${r.score})`).join(', ')}`)

const registry = loadRegistry(dataDir)
const families = catalogFamilies(registry, config)
assert.ok(families.length >= 4, `expected generator families, got ${families.length}`)
for (const family of families) assert.ok(family.presets.length > 0, `family ${family.id} has no presets`)
console.log(`families     : ${families.map((f) => `${f.id}[${f.presets.length}]`).join(', ')}`)

const fcc = registry.families.find((f) => f.id === 'fcc-cell')
assert.ok(fcc, 'fcc-cell family missing')
const fccPresets = families.find((f) => f.id === 'fcc-cell').presets
assert.ok(fccPresets.every((p) => /^fcc_cell_/.test(p)), `fcc presets not filtered: ${fccPresets}`)

const outDir = full ? join(config.projectRoot, '.cache', 'mesh-smoke', 'fcc') : join(config.projectRoot, '.cache', 'mesh-smoke', 'dry')
const plan = await runFamily(config, fcc, { preset: fcc.defaultPreset, outDir, dryRun: true, name: 'smoke-fcc' })
assert.ok(plan.dryRun === true, 'dry run not flagged')
assert.ok(plan.commands.length > 0, 'no commands planned')
console.log(`dry run      : ${plan.commands.length} command(s), preset ${plan.params ? 'resolved' : '?'}`)

if (full) {
  const result = await runFamily(config, fcc, { preset: fcc.defaultPreset, outDir, name: 'smoke-fcc' })
  assert.equal(result.ok, true, `generation failed: ${JSON.stringify(result.failure ?? result.missingOutputs)}`)
  for (const file of result.files) {
    assert.ok(['PASS', 'WARN'].includes(file.qa?.verdict ?? 'PASS'), `${file.path} QA ${file.qa?.verdict}`)
  }
  console.log(`generated    : ${result.files.map((f) => `${f.path}:${f.qa?.verdict ?? 'no-qa'}`).join(', ')}`)
} else {
  console.log('real generation skipped (pass --full)')
}
if (!process.exitCode) console.log('SMOKE OK')
