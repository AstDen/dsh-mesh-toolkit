/**
 * 1.3.1 (found by exp-027): a clipped STL is the defect that produced a mesh passing checkMesh
 * with no inlet/outlet at all — the scaffold now refuses it. snappy's own illegal-face count is
 * parsed and reported but is not a verdict (its minVol is far stricter than the measured one).
 * Also pins the solver skeleton: a case must be runnable as soon as the fields exist.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseSnappyLog, mesherCheck } from '../../sim-core/lib/checkmesh.js'
import { writeSnappyCase } from '../lib/scaffold.js'
import { boxTriangles, writeAsciiStl } from './helpers.mjs'

const SNAPPY_OK = `Snapped mesh : cells:290099  faces:934730  points:355920
Finished meshing with 0 illegal faces (concave, zero area or negative cell pyramid volume)`

const SNAPPY_BAD = `Snapped mesh : cells:242699  faces:780000  points:300000
Finished meshing with 438787 illegal faces (concave, zero area or negative cell pyramid volume)`

test('parseSnappyLog reads the illegal-face count and the cell count', () => {
  assert.deepEqual(parseSnappyLog(SNAPPY_OK), { illegalFaces: 0, cells: 290099, snapped: true })
  assert.deepEqual(parseSnappyLog(SNAPPY_BAD), { illegalFaces: 438787, cells: 242699, snapped: true })
  assert.deepEqual(parseSnappyLog('nothing to see'), { illegalFaces: null, cells: null, snapped: false })
  assert.deepEqual(parseSnappyLog(null), { illegalFaces: null, cells: null, snapped: false })
})

test('mesherCheck passes a clean log and fails a dirty one with the numbers', () => {
  assert.equal(mesherCheck(SNAPPY_OK).status, 'ok')
  const bad = mesherCheck(SNAPPY_BAD)
  assert.equal(bad.status, 'illegal-faces')
  assert.equal(bad.illegalFaces, 438787)
  assert.match(bad.message, /438787 illegal faces/)
  // no log at all must not invent a failure
  assert.equal(mesherCheck(null).status, 'ok')
})

test('the scaffold writes a runnable steady-laminar skeleton, not an empty shell', () => {
  const root = mkdtempSync(join(tmpdir(), 'mesh-skel-'))
  const stl = join(root, 'cube.stl')
  writeAsciiStl(stl, boxTriangles([-0.005, -0.005, -0.005], [0.005, 0.005, 0.005]))
  const caseDir = join(root, 'case')
  mkdirSync(caseDir, { recursive: true })
  const config = { projectRoot: root, caseRoots: [root], np: 1, timeoutMs: 60000, maxOutputChars: 4000 }
  const caps = {
    distribution: 'com',
    version: 'v2606',
    dictKeys: { blockMeshUnits: 'scale', layerAxis: 'minMedialAxisAngle' },
    matrix: { values: { snappyKeys: {} } },
  }
  const result = writeSnappyCase(config, caseDir, {
    stl: [stl],
    domainMin: [-0.01, -0.01, -0.01],
    domainMax: [0.01, 0.01, 0.01],
    cellSize: 0.002,
    locationInMesh: [0.008, 0.008, 0.008],
    refinementLevels: { cube: 1 },
    caps,
  })

  const solution = readFileSync(join(caseDir, 'system', 'fvSolution'), 'utf8')
  assert.match(solution, /solver\s+GAMG/, 'p solver must be a real solver, not an empty block')
  assert.match(solution, /solver\s+smoothSolver/)
  assert.match(solution, /residualControl/)
  assert.match(solution, /relaxationFactors/)
  assert.doesNotMatch(solution, /solvers\s*\{\s*\}/, 'the empty placeholder must be gone')

  const schemes = readFileSync(join(caseDir, 'system', 'fvSchemes'), 'utf8')
  assert.match(schemes, /div\(phi,U\)\s+Gauss linearUpwind/)

  const control = readFileSync(join(caseDir, 'system', 'controlDict'), 'utf8')
  assert.match(control, /application\s+simpleFoam;/)
  assert.match(control, /endTime\s+1000;/)

  assert.match(String(result.solverSkeleton ?? ''), /0\/U and 0\/p are not written/)
})

test('the scaffold refuses an STL that sticks out of the domain (exp-027 attempt 1)', () => {
  const root = mkdtempSync(join(tmpdir(), 'mesh-clip-'))
  const stl = join(root, 'cube.stl')
  writeAsciiStl(stl, boxTriangles([-0.005, -0.005, -0.005], [0.005, 0.005, 0.005]))
  const caseDir = join(root, 'case')
  mkdirSync(caseDir, { recursive: true })
  const config = { projectRoot: root, caseRoots: [root], np: 1, timeoutMs: 60000, maxOutputChars: 4000 }
  const caps = {
    distribution: 'com',
    version: 'v2606',
    dictKeys: { blockMeshUnits: 'scale', layerAxis: 'minMedialAxisAngle' },
    matrix: { values: { snappyKeys: {} } },
  }
  // half of the cube hangs out of the box
  assert.throws(
    () => writeSnappyCase(config, caseDir, {
      stl: [stl],
      domainMin: [0, 0, 0],
      domainMax: [0.008, 0.008, 0.008],
      cellSize: 0.001,
      locationInMesh: [0.002, 0.002, 0.002],
      refinementLevels: { cube: 1 },
      caps,
    }),
    /refusing to mesh: a clipped surface yields a mesh that passes checkMesh but has no inlet\/outlet/,
  )

  // the documented escape hatch keeps the old behaviour, with the warning
  const ok = writeSnappyCase(config, caseDir, {
    stl: [stl],
    domainMin: [0, 0, 0],
    domainMax: [0.008, 0.008, 0.008],
    cellSize: 0.001,
    locationInMesh: [0.002, 0.002, 0.002],
    refinementLevels: { cube: 1 },
    allowClipping: true,
    caps,
  })
  assert.ok(ok.warnings.some((w) => /exceeds the domain/.test(w)), JSON.stringify(ok.warnings))
})
