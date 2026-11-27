/**
 * Unit tests for the 1.2.0 scaffold keys (plan S3, audit D-2, D-3, D-4):
 * `nCellsBetweenLevels`, `refinementRegions` and the relaxed-pass threshold.
 *
 * Dictionary text comes from `writeSnappyCase` with a stubbed capability probe, so no OpenFOAM is
 * needed — only a cube STL written by the helpers.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { writeSnappyCase } from '../lib/scaffold.js'
import { boxTriangles, writeAsciiStl } from './helpers.mjs'

const COM2606 = {
  distribution: 'com',
  version: 'v2606',
  dictKeys: { blockMeshUnits: 'scale', layerAxis: 'minMedialAxisAngle' },
  matrix: { values: { snappyKeys: {} } },
}

function scaffold(options = {}, caps = COM2606) {
  const root = mkdtempSync(join(tmpdir(), 'mesh-ref-'))
  const stl = join(root, 'cube.stl')
  writeAsciiStl(stl, boxTriangles([-0.005, -0.005, -0.005], [0.005, 0.005, 0.005]))
  const caseDir = join(root, 'case')
  mkdirSync(caseDir, { recursive: true })
  const config = { projectRoot: root, caseRoots: [root], np: 1, timeoutMs: 60000, maxOutputChars: 4000 }
  const result = writeSnappyCase(config, caseDir, {
    stl: [stl],
    domainMin: [-0.01, -0.01, -0.01],
    domainMax: [0.01, 0.01, 0.01],
    cellSize: 0.002,
    locationInMesh: [0.008, 0.008, 0.008],
    refinementLevels: { cube: 1 },
    caps,
    ...options,
  })
  return { caseDir, dict: readFileSync(join(caseDir, 'system', 'snappyHexMeshDict'), 'utf8'), result }
}

const section = (dict, name) => {
  const start = dict.indexOf(`    ${name}\n    {`)
  if (start < 0) throw new Error(`no ${name} block in the dictionary`)
  return dict.slice(start, dict.indexOf('\n    }', start))
}

// --- D-3 -------------------------------------------------------------------

test('D-3: nCellsBetweenLevels is 4 by default and follows the option', () => {
  assert.match(scaffold().dict, /nCellsBetweenLevels 4;/)
  assert.match(scaffold({ nCellsBetweenLevels: 2 }).dict, /nCellsBetweenLevels 2;/)
})

test('D-3: a non-integer, zero or runaway value is refused before writing', () => {
  for (const bad of [0, -1, 1.5, 11, 'three']) {
    assert.throws(() => scaffold({ nCellsBetweenLevels: bad }), /nCellsBetweenLevels must be an integer 1\.\.10/)
  }
})

// --- D-2 -------------------------------------------------------------------

test('D-2: a box refinement region is written as a searchableBox with both levels', () => {
  const { dict } = scaffold({
    refinementRegions: [{ name: 'wake', min: [0, -0.005, -0.005], max: [0.008, 0.005, 0.005], level: [2, 3] }],
  })
  const block = section(dict, 'refinementRegions')
  assert.match(block, /type searchableBox;/)
  assert.match(block, /min \(0 -0\.005 -0\.005\);/)
  assert.match(block, /max \(0\.008 0\.005 0\.005\);/)
  assert.match(block, /mode inside;/)
  assert.match(block, /levels \(\(2 3\)\);/)
})

test('D-2: a sphere region and an outside mode are written; a scalar level becomes a pair', () => {
  const { dict } = scaffold({
    refinementRegions: [{ name: 'pore', type: 'sphere', centre: [0, 0, 0], radius: 0.004, mode: 'outside', level: 2 }],
  })
  const block = section(dict, 'refinementRegions')
  assert.match(block, /type searchableSphere;/)
  assert.match(block, /centre \(0 0 0\);/)
  assert.match(block, /radius 0\.004;/)
  assert.match(block, /mode outside;/)
  assert.match(block, /levels \(\(2 2\)\);/)
})

test('D-2: refinementRegions coexist with advanced.directional', () => {
  const { dict } = scaffold({
    refinementRegions: [{ name: 'wake', min: [0, -0.005, -0.005], max: [0.008, 0.005, 0.005], level: [1, 2] }],
    advanced: { directional: { levels: [1, 2], increment: [0, 1, 0] } },
  })
  const block = section(dict, 'refinementRegions')
  assert.match(block, /searchableBox/)
  assert.match(block, /directional/)
  assert.match(block, /levelIncrement \(1 2 \(0 1 0\)\);/)
})

test('D-2: every malformed region is refused with the index and the reason', () => {
  const cases = [
    [{ refinementRegions: 'box' }, /refinementRegions must be an array/],
    [{ refinementRegions: [null] }, /refinementRegions\[0\] must be an object/],
    [{ refinementRegions: [{ type: 'cylinder', level: 1 }] }, /type must be "box" or "sphere"/],
    [{ refinementRegions: [{ min: [0.05, 0, 0], max: [0.06, 0.001, 0.001], level: 1 }] }, /does not intersect the domain/],
    [{ refinementRegions: [{ min: [0.005, 0, 0], max: [0.001, 0.001, 0.001], level: 1 }] }, /min < max on every axis/],
    [{ refinementRegions: [{ type: 'sphere', centre: [0, 0, 0], radius: 0, level: 1 }] }, /positive radius/],
    [{ refinementRegions: [{ min: [0, 0, 0], max: [0.001, 0.001, 0.001], mode: 'sideways', level: 1 }] }, /mode must be inside or outside/],
  ]
  for (const [options, pattern] of cases) assert.throws(() => scaffold(options), pattern)
})

// --- D-4 -------------------------------------------------------------------

test('D-4: the relaxed pass is maxNonOrtho + 15, not 180', () => {
  // the built-in maxNonOrtho default is 65, so a bare scaffold relaxes to 80
  const { dict } = scaffold()
  assert.match(dict, /relaxed\s*\{[\s\S]*?maxNonOrtho 80;/)
  assert.ok(!/maxNonOrtho 180;/.test(dict), 'the relaxed pass must not be switched off with 180')
})

test('D-4: the relaxed threshold follows maxNonOrtho, is capped below 90 and can be overridden', () => {
  assert.match(scaffold({ maxNonOrtho: 70 }).dict, /relaxed\s*\{[\s\S]*?maxNonOrtho 85;/)
  assert.match(scaffold({ maxNonOrtho: 80 }).dict, /relaxed\s*\{[\s\S]*?maxNonOrtho 89;/)
  assert.match(scaffold({ relaxedMaxNonOrtho: 88 }).dict, /relaxed\s*\{[\s\S]*?maxNonOrtho 88;/)
  assert.throws(() => scaffold({ relaxedMaxNonOrtho: -5 }), /relaxedMaxNonOrtho must be a positive angle/)
})
