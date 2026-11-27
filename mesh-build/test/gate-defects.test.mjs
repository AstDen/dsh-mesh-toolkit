// S3 defect tests (plan 1.1.1): D-6 derived minVol, D-7 layer coverage parsed by faces,
// D-10 the minLayerCoverage threshold actually decides something, D-1 one owner per hint card.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

import { parseCheckMesh } from '../../sim-core/lib/checkmesh.js'
import { layerCoverageCheck } from '../../sim-core/lib/gate.js'
import { deriveMinVol, minVolFromSetup } from '../lib/minvol.js'
import { loadHints } from '../../sim-core/lib/hints.js'

const here = dirname(fileURLToPath(import.meta.url))
const cacheRoot = join(here, '..', '..', '..', '.cache', 'unit-tmp')

function scratch(name) {
  mkdirSync(cacheRoot, { recursive: true })
  return mkdtempSync(join(cacheRoot, `${name}-`))
}

/** Real checkMesh tail: the `Mesh OK` line plus a layer summary the mesher printed. */
function checkMeshLog(layerLine = '') {
  return [
    'Create time',
    '',
    'Mesh stats',
    '    points:           25552',
    '    faces:            63826',
    '    internal faces:   29779',
    '    cells:            19186',
    '    faces per cell:   6.5',
    'Checking geometry...',
    '    Overall domain bounding box (-0.1 -0.1 -0.05) (0.1 0.1 0.05)',
    '    Mesh non-orthogonality Max: 50.9531 average: 8.5',
    '    Max skewness = 3.37818 OK.',
    '    Min volume = 1.88171e-11. Max aspect ratio = 5.0 OK.',
    '    Min face weight (Jasak) = 0.02 OK.',
    '    Min volume ratio (skewness) = 0.1 OK.',
    '    Min determinant = 0.1 OK.',
    'Mesh OK.',
    layerLine,
  ].filter((line) => line !== '').join('\n')
}

test('D-7: snappy prints layer coverage by cells and by faces', () => {
  const both = parseCheckMesh(checkMeshLog('Added 122977 out of 122977 cells (100%)'))
  assert.deepEqual(both.layers, { added: 122977, outOf: 122977, percent: 100 })
  assert.equal(both.layersFaces, null, 'no Extruding line, so no face coverage')

  const faces = parseCheckMesh(checkMeshLog('Extruding 3792 out of 3792 faces (100%)'))
  assert.equal(faces.layers, null)
  assert.deepEqual(faces.layersFaces, { extruded: 3792, outOf: 3792, percent: 100 })

  const partial = parseCheckMesh(checkMeshLog('Extruding 51503 out of 52592 faces (97.9%)'))
  assert.deepEqual(partial.layersFaces, { extruded: 51503, outOf: 52592, percent: 97.9 })

  const none = parseCheckMesh(checkMeshLog('Extruding 0 out of 9600 faces (0%)'))
  assert.deepEqual(none.layersFaces, { extruded: 0, outOf: 9600, percent: 0 })

  const bothLines = parseCheckMesh(checkMeshLog([
    'Extruding 9600 out of 9600 faces (100%)',
    'Added 122977 out of 122977 cells (100%)',
  ].join('\n')))
  assert.deepEqual(bothLines.layers, { added: 122977, outOf: 122977, percent: 100 })
  assert.deepEqual(bothLines.layersFaces, { extruded: 9600, outOf: 9600, percent: 100 })
})

test('D-10: minLayerCoverage decides only when a threshold is configured and layers exist', () => {
  const faces = { extruded: 7990, outOf: 9600, percent: 83.2292 }
  assert.deepEqual(layerCoverageCheck({ layersFaces: faces, required: null }), {
    status: 'disabled', percent: 83.2292, required: null,
  })
  assert.equal(layerCoverageCheck({ layersFaces: faces, required: 0.8 }).status, 'ok')
  const below = layerCoverageCheck({ layersFaces: faces, required: 0.9 })
  assert.equal(below.status, 'below')
  assert.equal(below.required, 0.9)
  assert.match(below.message, /83\.2292% < 90%/)
  assert.equal(layerCoverageCheck({ layersFaces: null, required: 0.9 }).status, 'no-faces')
  assert.equal(layerCoverageCheck({ layersFaces: { extruded: 0, outOf: 0, percent: 0 }, required: 0.9 }).status, 'no-faces')
})

test('D-6: a case without a configured minVol derives it from its own h_min', () => {
  // handoff.json route: cellSize_m / 2^maxLevel
  const withHandoff = scratch('minvol-handoff')
  writeFileSync(join(withHandoff, 'handoff.json'), JSON.stringify({
    schemaVersion: 'mesh-handoff/1',
    units: { stl: 'mm', case: 'm', scale: 0.001 },
    selection: { cells: [40, 32, 32], cellSize_m: 0.001 },
    levels: { cav: [1, 2] },
  }))
  const derived = deriveMinVol(withHandoff)
  assert.equal(derived.source, 'handoff-cellSize')
  assert.ok(Math.abs(derived.hMin - 0.00025) < 1e-12, `hMin ${derived.hMin}`)
  assert.ok(Math.abs(derived.minVol - (0.00025 ** 3) / 6) < 1e-18, `minVol ${derived.minVol}`)

  // no refinement levels at all: h_min is the background cell
  const plain = scratch('minvol-plain')
  writeFileSync(join(plain, 'handoff.json'), JSON.stringify({
    schemaVersion: 'mesh-handoff/1', selection: { cellSize_m: 0.002 }, levels: {},
  }))
  const plainDerived = deriveMinVol(plain)
  assert.equal(plainDerived.source, 'handoff-cellSize')
  assert.ok(Math.abs(plainDerived.hMin - 0.002) < 1e-12)

  // a mean cell size is NOT a valid stand-in for h_min: without a handoff there is nothing to derive
  const passport = scratch('minvol-passport')
  mkdirSync(join(passport, 'constant', 'polyMesh'), { recursive: true })
  writeFileSync(join(passport, 'mesh-passport.json'), JSON.stringify({ cells: 1000 }))
  writeFileSync(join(passport, 'constant', 'polyMesh', 'points'), 'FoamFile\n{ format ascii; }\n8\n( (0 0 0) (0.01 0 0) )\n')
  assert.equal(deriveMinVol(passport), null)

  const empty = scratch('minvol-empty')
  assert.equal(deriveMinVol(empty), null)

  // the scaffold knows both numbers before a handoff exists
  const fromScaffold = minVolFromSetup({ cellSize_m: 0.001, levels: { cav: [1, 2] } })
  assert.equal(fromScaffold.source, 'scaffold-cellSize')
  assert.ok(Math.abs(fromScaffold.minVol - 0.00025 ** 3 / 6) < 1e-18)
  assert.equal(minVolFromSetup({ levels: { cav: [1] } }), null)
})

test('D-1: every hint card id has exactly one owner across packages', () => {
  const px = join(here, '..', '..')
  const buildDir = join(px, 'mesh-build', 'data', 'hints')
  const stlDir = join(px, 'mesh-stl', 'data', 'hints')
  const build = loadHints(buildDir).cards
  const stl = loadHints(stlDir).cards
  const seen = new Map()
  const dupes = []
  for (const card of [...build.map((c) => ({ ...c, pkg: 'mesh-build' })), ...stl.map((c) => ({ ...c, pkg: 'mesh-stl' }))]) {
    if (seen.has(card.id)) dupes.push(`${card.id} (${seen.get(card.id)} + ${card.pkg})`)
    else seen.set(card.id, card.pkg)
  }
  assert.deepEqual(dupes, [], `duplicated card ids: ${dupes.join('; ')}`)
})
