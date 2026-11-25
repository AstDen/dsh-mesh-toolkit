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
import { loadHintsWithFallback, searchHints } from '../lib/hints.js'
import { normalizeLocations, writeSnappyCase } from '../lib/scaffold.js'
import { versionInfo } from '../lib/common.js'
import { readCasePatches } from '../lib/patches.js'

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

const hints = loadHintsWithFallback(join(dataDir, 'hints'), { dir: join(config.packageRoot, '..', 'mesh-stl', 'data', 'hints'), label: 'mesh-stl' })
assert.ok(hints.cards.length >= 15, `expected hint cards, got ${hints.cards.length}`)
assert.equal(hints.errors.length, 0, `hint load errors: ${JSON.stringify(hints.errors)}`)
console.log(`hints        : ${hints.cards.length} cards from ${hints.files.length} files (borrowed ${hints.borrowed} from mesh-stl)`)
// a question that belongs to the sibling plugin must be answerable here too
const cross = searchHints(hints.cards, 'watertight cleanup', 3).matches.map((m) => m.id)
assert.ok(cross.some((id) => id === 'stl-contract' || id === 'stl-cleanup'), `cross-plugin hit missing: ${cross}`)
console.log(`cross-plugin : ${cross.join(', ')}`)

const vi = versionInfo(config.packageRoot)
assert.equal(vi.stale, false, `version on disk differs from the loaded one: ${JSON.stringify(vi)}`)
console.log(`version      : ${vi.reported} (disk ${vi.onDisk})`)
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
      stl: { files: [stl], missing: [] },   // regression: expandStlInputs() result, not a path list
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

    // regression: a single [x,y,z] point is accepted without the outer list
    const one = normalizeLocations([0.001, 0.001, 0.001])
    assert.equal(one.length, 1, `normalizeLocations([x,y,z]) gave ${one.length} points`)
    assert.deepEqual(one[0].point, [0.001, 0.001, 0.001])
    console.log(`locations    : ${one.length} point, name ${one[0].name}`)

    // the cfmesh route has no scaffold: preflight must name the missing dictionary
    const cfmesh = engine.routes.find((r) => r.id === 'cfmesh')
    const cfProblems = preflight(config, cfmesh, {}, temp)
    assert.ok(cfProblems.some((p) => p.includes('system/meshDict')), `cfmesh preflight: ${JSON.stringify(cfProblems)}`)
    console.log(`preflight    : cfmesh -> ${cfProblems.join('; ')}`)

    // no polyMesh yet: the patch reader must report "no entries", not throw
    const patches = readCasePatches(temp)
    assert.equal(patches.entries.length, 0, `patch reader found entries without a mesh: ${JSON.stringify(patches)}`)
    console.log(`patches      : ${patches.entries.length} entries before meshing`)
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
if (!process.exitCode) console.log('SMOKE OK')
