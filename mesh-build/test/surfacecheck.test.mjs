import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  compareSurfaces,
  exportPatchTriangles,
  hausdorffApprox,
  buildGrid,
  readPolyMeshBoundary,
  readPolyMeshFaces,
  readPolyMeshPoints,
  readTriangles,
  surfaceMetrics,
  writeTrianglesStl,
} from '../lib/surfacecheck.js'
import { boxTriangles, writeAsciiStl, writeBinaryStl } from './helpers.mjs'

const close = (actual, expected, tol = 1e-9) => Math.abs(actual - expected) <= tol

test('surfaceMetrics measures a 10 mm cube: area 6e-4 m2, volume 1e-6 m3', () => {
  const metrics = surfaceMetrics(boxTriangles([-0.005, -0.005, -0.005], [0.005, 0.005, 0.005]))
  assert.equal(metrics.triangles, 12)
  assert.ok(close(metrics.volume, 1e-6, 1e-12), `volume ${metrics.volume}`)
  assert.ok(close(metrics.area, 6e-4, 1e-12), `area ${metrics.area}`)
  assert.deepEqual(metrics.bbox.min.map((v) => Number(v.toFixed(6))), [-0.005, -0.005, -0.005])
  assert.ok(close(metrics.bbox.max[0], 0.005, 1e-12))
})

test('readTriangles reads ASCII and binary STL to the same triangles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-'))
  const triangles = boxTriangles([0, 0, 0], [0.01, 0.01, 0.01])
  const ascii = readTriangles(writeAsciiStl(join(dir, 'a.stl'), triangles))
  const binary = readTriangles(writeBinaryStl(join(dir, 'b.stl'), triangles))
  assert.equal(ascii.length, 12 * 9, 'readTriangles returns a flat vertex array')
  assert.equal(binary.length, 12 * 9)
  const volumeAscii = surfaceMetrics(ascii).volume
  const volumeBinary = surfaceMetrics(binary).volume
  // binary STL stores float32, so equality is relative, not exact
  assert.ok(Math.abs(volumeAscii - volumeBinary) / volumeAscii < 1e-6, `${volumeAscii} vs ${volumeBinary}`)
})

test('a truncated binary STL is refused with the byte counts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-'))
  const file = writeBinaryStl(join(dir, 'short.stl'), boxTriangles([0, 0, 0], [1, 1, 1]))
  const buffer = readFileSync(file).subarray(0, 84 + 50 * 3)
  writeFileSync(join(dir, 'cut.stl'), buffer)
  assert.throws(() => readTriangles(join(dir, 'cut.stl')), /binary STL is truncated: declares 12 triangles \(684 bytes\), file has/)
})

test('compareSurfaces passes an identical pair and fails a clipped domain', () => {
  const reference = boxTriangles([0, 0, 0], [0.01, 0.01, 0.01])
  const same = compareSurfaces(reference, reference)
  assert.equal(same.pass, true)
  assert.ok(same.diffs.hausdorffRel < 1e-9)
  assert.ok(same.diffs.bboxRel < 1e-9)

  // snappy clipped the 10 mm cube at z = 5 mm (the DEF-11 benchmark case)
  const clipped = boxTriangles([0, 0, 0], [0.01, 0.01, 0.005])
  const bad = compareSurfaces(reference, clipped)
  assert.equal(bad.pass, false)
  assert.ok(close(bad.diffs.bboxRel, 0.2887, 1e-4), `bboxRel ${bad.diffs.bboxRel}`)
  assert.ok(bad.diffs.volRel > 0.4)
})

test('area alone does not fail the verdict: a stair-stepped surface is expected', () => {
  const reference = boxTriangles([0, 0, 0], [0.01, 0.01, 0.01])
  // the same cube with two extra ridges on the top face: area grows, bbox and Hausdorff do not
  const ridged = [...reference, ...boxTriangles([0, 0, 0.01], [0.01, 0.005, 0.0101])]
  const result = compareSurfaces(reference, ridged, { tol: 0.05, samples: 400 })
  assert.ok(result.diffs.areaRel > 0.1, `areaRel ${result.diffs.areaRel}`)
  assert.equal(result.pass, true)
  assert.match(result.note, /stair-stepped|area/)
})

test('hausdorffApprox measures a known offset', () => {
  const reference = boxTriangles([0, 0, 0], [0.01, 0.01, 0.01])
  const shifted = boxTriangles([0, 0, 0.002], [0.01, 0.01, 0.012])
  const index = buildGrid(reference, 16)
  const { hausdorff, samples } = hausdorffApprox(shifted, index, 500)
  assert.ok(close(hausdorff, 0.002, 1e-4), `hausdorff ${hausdorff}`)
  assert.ok(samples >= 1)
})

test('writeTrianglesStl round-trips through readTriangles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-'))
  const triangles = boxTriangles([-0.002, -0.002, -0.002], [0.002, 0.002, 0.002])
  const written = writeTrianglesStl(join(dir, 'out.stl'), triangles)
  assert.equal(written.triangles, 12)
  const back = readTriangles(written.file)
  assert.equal(back.length, 12 * 9)
  assert.ok(close(surfaceMetrics(back).area, 6 * 0.004 * 0.004, 1e-12))
})

test('exportPatchTriangles reads a polyMesh and fans a quad into two triangles', () => {
  const dir = mkdtempSync(join(tmpdir(), 'surface-'))
  const mesh = join(dir, 'constant', 'polyMesh')
  mkdirSync(mesh, { recursive: true })
  // one quad in the z = 0 plane, 10 mm x 10 mm, wound counter-clockwise seen from +z
  writeFileSync(join(mesh, 'points'), [
    'FoamFile { format ascii; }',
    '4',
    '(',
    '(0 0 0)',
    '(0.01 0 0)',
    '(0.01 0.01 0)',
    '(0 0.01 0)',
    ')',
    '',
  ].join('\n'))
  writeFileSync(join(mesh, 'faces'), ['FoamFile { format ascii; }', '1', '(', '4(0 1 2 3)', ')', ''].join('\n'))
  writeFileSync(join(mesh, 'boundary'), [
    'FoamFile { format ascii; }',
    '2',
    '(',
    'walls',
    '{',
    '    type wall;',
    '    nFaces 1;',
    '    startFace 0;',
    '}',
    'world',
    '{',
    '    type symmetry;',
    '    nFaces 0;',
    '    startFace 1;',
    '}',
    ')',
    '',
  ].join('\n'))

  const points = readPolyMeshPoints(join(mesh, 'points'))
  assert.equal(points.length, 4 * 3, 'points come back flat: x y z per point')
  assert.deepEqual(Array.from(points.slice(0, 3)), [0, 0, 0])
  const faces = readPolyMeshFaces(join(mesh, 'faces'))
  assert.deepEqual(faces.map((face) => [face.size, face.vertex]), [[4, [0, 1, 2, 3]]])
  const boundary = readPolyMeshBoundary(join(mesh, 'boundary'))
  assert.equal(boundary.length, 2)
  assert.deepEqual(boundary.map((p) => [p.name, p.type, p.nFaces, p.startFace]), [
    ['walls', 'wall', 1, 0],
    ['world', 'symmetry', 0, 1],
  ])

  const exported = exportPatchTriangles(dir, ['walls'])
  assert.equal(exported.patches.length, 1)
  assert.equal(exported.faces, 1)
  assert.equal(exported.triangles.length, 2 * 9, 'a quad fans into two triangles')
  assert.equal(exported.faces, 1)
  assert.ok(close(surfaceMetrics(exported.triangles).area, 1e-4, 1e-12), 'quad area is 10 mm x 10 mm')
  assert.throws(() => exportPatchTriangles(dir, ['nope']), /patch not found: nope; the case has walls, world/)
})
