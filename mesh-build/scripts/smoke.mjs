#!/usr/bin/env node
/**
 * mesh-build smoke test — works without a DSH host.
 * Checks: config detection, engine routes, hint cards, scaffold into a temp dir,
 * route plan (serial + parallel). Nothing is meshed and the project is not touched.
 * Usage: node scripts/smoke.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from '../lib/common.js'
import { catalogRoutes, loadEngine, makeContext, planRoute, preflight } from '../lib/routes.js'
import { loadHints, searchHints } from '../lib/hints.js'
import { writeSnappyCase } from '../lib/scaffold.js'

const fail = (message) => { console.error(`FAIL ${message}`); process.exitCode = 1 }

const config = normalizeConfig({})
console.log(`project root : ${config.projectRoot || '(not detected)'}`)
console.log(`configured   : ${config.configured}`)
if (!config.configured) {
  fail('project not detected — run from inside Mesh_3D_pore_scale or set MESH_BUILD_PROJECT_ROOT')
  process.exit(1)
}

const dataDir = join(config.packageRoot, 'data')
const engine = loadEngine(dataDir)
const routes = catalogRoutes(engine)
assert.ok(routes.length >= 4, `expected routes, got ${routes.length}`)
console.log(`routes       : ${routes.map((r) => `${r.id}(${r.steps.length})`).join(', ')}`)
assert.ok(engine.profiles?.project?.maxNonOrtho === 60, 'project profile missing/wrong')

const hints = loadHints(join(dataDir, 'hints'))
assert.ok(hints.cards.length >= 15, `expected hint cards, got ${hints.cards.length}`)
assert.equal(hints.errors.length, 0, `hint load errors: ${JSON.stringify(hints.errors)}`)
console.log(`hints        : ${hints.cards.length} cards from ${hints.files.length} files`)
const search = searchHints(hints.cards, 'non-ortho layers', 3)
assert.ok(search.matches.length > 0, 'search returned nothing')
console.log(`search       : ${search.matches.map((r) => `${r.id}(${r.score})`).join(', ')}`)

const stl = join(config.projectRoot, 'stl', 'fcc_cell_r049_v1.stl')
if (!existsSync(stl)) {
  console.log(`scaffold skipped: ${stl} not found`)
} else {
  const temp = mkdtempSync(join(tmpdir(), 'mesh-build-smoke-'))
  try {
    const written = writeSnappyCase(config, temp, {
      stl: [stl],
      domainMin: [0, 0, -0.0125],
      domainMax: [0.0035355339, 0.0035355339, 0.0070710678],
      cellSize: 0.0005,
      locationInMesh: [{ point: [0.0017, 0.0017, -0.010], name: 'fluid' }],
      np: 6,
    })
    for (const relative of written.files) assert.ok(existsSync(join(temp, relative)), `missing ${relative}`)
    assert.ok(existsSync(join(temp, 'constant', 'triSurface', 'fcc_cell_r049_v1.stl')), 'STL not copied')
    console.log(`scaffold     : ${written.files.length} dicts, cells ${written.cells.join('x')}, patch ${written.patchType}`)

    const snappy = engine.routes.find((r) => r.id === 'snappy')
    const serial = planRoute(snappy, makeContext(config, { np: 1 }, temp)).map((s) => s.name)
    const parallel = planRoute(snappy, makeContext(config, { np: 6 }, temp)).map((s) => s.name)
    assert.ok(serial.includes('snappyHexMesh'), `serial plan: ${serial}`)
    assert.ok(parallel.includes('snappyHexMesh-parallel'), `parallel plan: ${parallel}`)
    assert.ok(!parallel.includes('snappyHexMesh'), 'parallel plan contains serial step')
    console.log(`plan serial  : ${serial.join(' -> ')}`)
    console.log(`plan np=6    : ${parallel.join(' -> ')}`)
    assert.deepEqual(preflight(config, snappy, { np: 6 }, temp), [], 'preflight failed on a fresh scaffold')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
if (!process.exitCode) console.log('SMOKE OK')
