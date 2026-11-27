/**
 * Unit tests for `mesh-build/lib/fluidpoint.js` (plan S3, audit D-8) — the JS replacement for
 * `scripts/fluid-point.py`. No OpenFOAM, no python: only STLs written by the helpers.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { suggestFluidPoint, trianglesBbox } from '../lib/fluidpoint.js'
import { boxTriangles, writeAsciiStl } from './helpers.mjs'

/** A closed UV sphere as a flat triangle list (same units as the callers). */
function sphereTriangles(centre, radius, segments = 24, rings = 16) {
  const tris = []
  const pt = (i, j) => {
    const theta = (j / rings) * Math.PI
    const phi = (i / segments) * 2 * Math.PI
    return [
      centre[0] + radius * Math.sin(theta) * Math.cos(phi),
      centre[1] + radius * Math.sin(theta) * Math.sin(phi),
      centre[2] + radius * Math.cos(theta),
    ]
  }
  const push = (a, b, c) => {
    // orient every triangle outwards: normal must point away from the centre
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const mid = [(a[0] + b[0] + c[0]) / 3 - centre[0], (a[1] + b[1] + c[1]) / 3 - centre[1], (a[2] + b[2] + c[2]) / 3 - centre[2]]
    const flip = n[0] * mid[0] + n[1] * mid[1] + n[2] * mid[2] < 0
    tris.push(...(flip ? [...a, ...c, ...b] : [...a, ...b, ...c]))
  }
  for (let j = 0; j < rings; j += 1) {
    for (let i = 0; i < segments; i += 1) {
      const a = pt(i, j)
      const b = pt(i + 1, j)
      const c = pt(i + 1, j + 1)
      const d = pt(i, j + 1)
      push(a, b, c)
      push(a, c, d)
    }
  }
  return tris
}

function writeStl(flat, name = 'geom.stl') {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-fluid-'))
  const file = join(dir, name)
  writeAsciiStl(file, flat)
  return file
}

test('fluidpoint: a point outside a solid box clears the requested distance', () => {
  // 10 mm cube (mm units on disk), domain 100 mm wide around it
  const file = writeStl(boxTriangles([-5, -5, -5], [5, 5, 5]))
  const point = suggestFluidPoint([file], { domainMin: [-0.05, -0.05, -0.05], domainMax: [0.05, 0.05, 0.05], clearance_mm: 0.5 })
  assert.equal(point.ok, true, point.reason)
  assert.equal(point.source, 'lattice+nearest-triangle')
  assert.ok(point.clearance_mm >= 0.5, `clearance ${point.clearance_mm} mm is below the requested 0.5 mm`)
  // outside the cube means at least one axis beyond ±5 mm
  const outside = point.point_m.some((v) => Math.abs(v) > 0.005)
  assert.ok(outside, `point ${JSON.stringify(point.point_mm)} mm is inside the solid cube`)
  assert.equal(point.point_mm.length, 3)
})

test('fluidpoint: with a sphere inside the box it returns a fluid point, not one in the solid', () => {
  // fluid = the box interior, the sphere is the only solid (what an internal domain ships)
  const sphere = writeStl(sphereTriangles([0, 0, 0], 2), 'sphere.stl')
  const point = suggestFluidPoint([sphere], {
    domainMin: [-0.005, -0.005, -0.005],
    domainMax: [0.005, 0.005, 0.005],
    clearance_mm: 0.2,
  })
  assert.equal(point.ok, true, point.reason)
  const [x, y, z] = point.point_m
  assert.ok(Math.abs(x) < 0.005 && Math.abs(y) < 0.005 && Math.abs(z) < 0.005, 'point left the box')
  const radius = Math.hypot(...point.point_m)
  assert.ok(radius > 0.002, `point ${radius * 1000} mm from the centre is inside the 2 mm sphere`)
})

test('fluidpoint: an impossible clearance is refused instead of returning a bad point', () => {
  const file = writeStl(boxTriangles([-5, -5, -5], [5, 5, 5]))
  const point = suggestFluidPoint([file], { domainMin: [-0.005, -0.005, -0.005], domainMax: [0.005, 0.005, 0.005], clearance_mm: 20 })
  assert.equal(point.ok, false)
  assert.match(point.reason, /no point at least 20 mm from every wall/)
})

test('fluidpoint: no STL is a refusal, not an exception', () => {
  assert.deepEqual(suggestFluidPoint([]), { ok: false, reason: 'no STL to read' })
})

test('fluidpoint: the sample is deterministic for a given seed', () => {
  const file = writeStl(boxTriangles([-5, -5, -5], [5, 5, 5]))
  const options = { domainMin: [-0.02, -0.02, -0.02], domainMax: [0.02, 0.02, 0.02], clearance_mm: 0.2, seed: 7 }
  const a = suggestFluidPoint([file], options)
  const b = suggestFluidPoint([file], options)
  assert.deepEqual(a.point_m, b.point_m)
  assert.equal(a.tested, b.tested)
})

test('fluidpoint: trianglesBbox reports the extent of a flat list', () => {
  const box = trianglesBbox(boxTriangles([-5, -1, 2], [5, 1, 4]))
  assert.deepEqual(box.min, [-5, -1, 2])
  assert.deepEqual(box.max, [5, 1, 4])
})
