/**
 * Unit tests for the advanced snappyHexMesh options (TW-02): every group of `scaffoldOptions.advanced`
 * is checked against the exact text it must produce, plus the capability refusals.
 *
 * The dictionary text is generated through `writeSnappyCase` with a stubbed capability probe, so the
 * test needs no OpenFOAM installation — only a cube STL (written by the helpers).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normalizeAdvanced, writeSnappyCase } from '../lib/scaffold.js'
import { boxTriangles, writeAsciiStl } from './helpers.mjs'

const COM2606 = {
  distribution: 'com',
  version: 'v2606',
  dictKeys: { blockMeshUnits: 'scale', layerAxis: 'minMedialAxisAngle' },
  matrix: {
    values: {
      snappyKeys: {
        gapLevel: true, gapMode: true, curvatureLevel: true, leakLevel: true, useLeakClosure: true,
        levelIncrement: true, outsidePoints: true, layerFields: true,
      },
    },
  },
}

const ORG14 = {
  distribution: 'org',
  version: '14',
  dictKeys: { blockMeshUnits: 'scale', layerAxis: 'minMedialAxisAngle' },
  matrix: {
    values: {
      snappyKeys: {
        gapLevel: true, gapMode: false, curvatureLevel: false, leakLevel: false, useLeakClosure: false,
        levelIncrement: false, outsidePoints: true, layerFields: true,
      },
    },
  },
}

/** Build a 10 mm cube STL and a scaffold around it; returns { dir, dict, warnings }. */
function scaffold(advanced, caps = COM2606) {
  const root = mkdtempSync(join(tmpdir(), 'mesh-adv-'))
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
    advanced,
  })
  return { dir: caseDir, dict: readFileSync(join(caseDir, 'system', 'snappyHexMeshDict'), 'utf8'), warnings: result.warnings }
}

test('default scaffold writes none of the advanced keys', () => {
  const { dict } = scaffold(null)
  for (const key of ['gapLevel', 'gapMode', 'curvatureLevel', 'leakLevel', 'useLeakClosure', 'levelIncrement', 'distributedTriSurfaceMesh', '_decomp', 'writeFlags', 'type box']) {
    assert.ok(!dict.includes(key), `default dictionary must not contain ${key}`)
  }
  assert.match(dict, /type triSurfaceMesh;/)
})

test('gap writes gapLevel and gapMode on the surface entry', () => {
  const { dict } = scaffold({ gap: { level: [4, 0, 10], mode: 'inside' } })
  assert.match(dict, /gapLevel \(4 0 10\);/)
  assert.match(dict, /gapMode inside;/)
  // per-surface: inside the refinementSurfaces entry, before the closing brace of that entry
  const surfaceBlock = dict.slice(dict.indexOf('refinementSurfaces'), dict.indexOf('resolveFeatureAngle'))
  assert.ok(surfaceBlock.includes('gapLevel (4 0 10);'))
})

test('gap.increment writes gapLevelIncrement in castellatedMeshControls', () => {
  const { dict } = scaffold({ gap: { level: [3, 1, 8], increment: 2 } })
  assert.match(dict, /gapLevelIncrement 2;/)
})

test('curvature writes the four-number curvatureLevel', () => {
  const { dict } = scaffold({ curvature: { cellsPerRadius: 10, minRadiusLevel: -1, maxLevel: 10 } })
  assert.match(dict, /curvatureLevel \(10 0 10 -1\);/)
})

test('leak writes useLeakClosure, outsidePoints and leakLevel', () => {
  const { dict } = scaffold({ leak: { closure: true, outsidePoints: [[0.009, 0.009, 0.009]], level: 2 } })
  assert.match(dict, /useLeakClosure true;/)
  assert.match(dict, /outsidePoints\n {4}\(\n {8}\(0\.009 0\.009 0\.009\)\n {4}\);/)
  assert.match(dict, /leakLevel 2;/)
})

test('directional writes a levelIncrement refinement region', () => {
  const { dict } = scaffold({ directional: { levels: [0, 1], increment: [0, 1, 1] } })
  const regions = dict.slice(dict.indexOf('refinementRegions'), dict.indexOf('allowFreeStandingZoneFaces'))
  assert.match(regions, /directional/)
  assert.match(regions, /mode inside;/)
  assert.match(regions, /levelIncrement \(0 1 \(0 1 1\)\);/)
})

test('zones writes faceZone, cellZone, cellZoneInside and insidePoints on the named surface', () => {
  const { dict } = scaffold({ zones: { cube: { cellZone: 'porous', faceZone: 'porousFaces', insidePoints: [[0, 0, 0]] } } })
  assert.match(dict, /faceZone porousFaces;/)
  assert.match(dict, /cellZone porous;/)
  assert.match(dict, /cellZoneInside insidePoint;/)
  assert.match(dict, /insidePoints \(\(0 0 0\)\);/)
})

test('distributed switches the surface type and writes _decomp with distributionType', () => {
  const { dict } = scaffold({ distributed: { n: [2, 2, 2], method: 'hierarchical', distributionType: 'nodeMaster' } })
  assert.match(dict, /type distributedTriSurfaceMesh;/)
  assert.match(dict, /distributionType nodeMaster;/)
  assert.match(dict, /_decomp\n {12}\{\n {16}n {6}\(2 2 2\);\n {16}method hierarchical;\n {12}\}/)
})

test('domainSurface box adds a searchable box from the domain bounds', () => {
  const { dict } = scaffold({ domainSurface: 'box' })
  assert.match(dict, /domain\n {8}\{\n {12}type box;/)
  assert.match(dict, /min \(-0\.01 -0\.01 -0\.01\);/)
  assert.match(dict, /max \(0\.01 0\.01 0\.01\);/)
})

test('quality.writeFlags writes the top-level writeFlags list', () => {
  const { dict } = scaffold({ quality: { writeFlags: ['layerFields', 'scalarLevels'] } })
  // The annotated dictionary puts writeFlags at the top level (NOT under debug): snappy reads it as a
  // wordList entry and refuses a subdictionary ("Attempt to return stream of primitives ... debug").
  assert.match(dict, /\nwriteFlags\n\(\n {4}layerFields\n {4}scalarLevels\n\);/)
  assert.ok(!dict.includes('debug\n{'))
})

test('org14: curvatureLevel is refused with the build named', () => {
  assert.throws(
    () => scaffold({ curvature: { cellsPerRadius: 10 } }, ORG14),
    /advanced asks for keys this build does not accept: curvature\.cellsPerRadius \(needs curvatureLevel\).*org 14.*switch to com2606/s,
  )
})

test('org14: gapLevel is written, gapMode is skipped with a warning', () => {
  const { dict, warnings } = scaffold({ gap: { level: [4, 0, 10], mode: 'inside' } }, ORG14)
  assert.match(dict, /gapLevel \(4 0 10\);/)
  assert.ok(!dict.includes('gapMode'))
  assert.match(warnings.join(' '), /OpenCFD-only \(gapMode\)/)
})

test('unknown advanced key and bad gap level are refused before any file is written', () => {
  assert.throws(() => normalizeAdvanced({ gapp: {} }), /unknown key\(s\): gapp/)
  assert.throws(() => normalizeAdvanced({ gap: { level: [4, 0] } }), /gap\.level must be \[numGapCells, minLevel, maxLevel\]/)
  assert.throws(() => normalizeAdvanced({ directional: { levels: [0, 1], increment: [0, 1] } }), /increment must be a direction/)
  assert.throws(() => normalizeAdvanced({ quality: { writeFlags: ['nope'] } }), /unknown flag\(s\): nope/)
})
