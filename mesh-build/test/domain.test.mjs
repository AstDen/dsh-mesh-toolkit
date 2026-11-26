import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_MARGINS,
  DOMAIN_TYPES,
  cellSizeFromTarget,
  cellsFromSize,
  computeDomain,
  scaleSuspicion,
  stlBboxMm,
} from '../lib/domain.js'
import { boxTriangles, writeAsciiStl } from './helpers.mjs'

const cube = { min: [-5, -5, -5], max: [5, 5, 5] } // 10 mm across, centred

test('external domain pads the flow axis and the laterals from L = max extent', () => {
  const domain = computeDomain({ bboxMm: cube, type: 'external' })
  // L = 10 mm: upstream 3L, downstream 5L on x; lateral 3L on y; vertical 3L/3L on z.
  assert.deepEqual(domain.domainMin, [-0.035, -0.035, -0.035])
  assert.deepEqual(domain.domainMax, [0.055, 0.035, 0.035])
  assert.equal(domain.type, 'external')
  assert.match(domain.notes.join(' '), /flow axis x/)
})

test('flowAxis moves the upstream/downstream margins to that axis', () => {
  const domain = computeDomain({ bboxMm: cube, type: 'external', flowAxis: 'y' })
  assert.deepEqual(domain.domainMin, [-0.035, -0.035, -0.035])
  assert.deepEqual(domain.domainMax, [0.035, 0.055, 0.035])
})

test('custom margins and sizeFactor scale the padding', () => {
  const domain = computeDomain({ bboxMm: cube, type: 'external', margins: { upstream: 1, downstream: 2, lateral: 1, vertical_top: 1, vertical_bottom: 1 }, sizeFactor: 2 })
  assert.deepEqual(domain.domainMin, [-0.025, -0.025, -0.025])
  assert.deepEqual(domain.domainMax, [0.045, 0.025, 0.025])
})

test('internal returns the bbox itself, wrap pads every side', () => {
  const internal = computeDomain({ bboxMm: cube, type: 'internal' })
  assert.deepEqual(internal.domainMin, [-0.005, -0.005, -0.005])
  assert.deepEqual(internal.domainMax, [0.005, 0.005, 0.005])
  assert.match(internal.notes.join(' '), /no margins/)

  const wrap = computeDomain({ bboxMm: cube, type: 'wrap' })
  assert.equal(DEFAULT_MARGINS.wrap, 0.1)
  assert.deepEqual(wrap.domainMin, [-0.006, -0.006, -0.006])
  assert.deepEqual(wrap.domainMax, [0.006, 0.006, 0.006])
})

test('box needs explicit bounds and unknown types are refused by name', () => {
  assert.throws(() => computeDomain({ bboxMm: cube, type: 'box' }), /explicit domainMin\/domainMax/)
  assert.throws(() => computeDomain({ bboxMm: cube, type: 'funnel' }), /domain\.type must be one of external, internal, wrap, box/)
  assert.deepEqual(DOMAIN_TYPES, ['external', 'internal', 'wrap', 'box'])
})

test('bad input is rejected instead of guessed', () => {
  assert.throws(() => computeDomain({}), /bboxMm \{ min: \[x,y,z\], max: \[x,y,z\] \}/)
  assert.throws(() => computeDomain({ bboxMm: { min: [0, 0, 0], max: [10, 10, 10] }, flowAxis: 'w' }), /flowAxis must be x, y or z/)
  assert.throws(() => computeDomain({ bboxMm: cube, sizeFactor: 0 }), /sizeFactor must be a positive number/)
  assert.throws(() => computeDomain({ bboxMm: { min: [1, 1, 1], max: [1, 1, 1] } }), /degenerate \(zero extent\)/)
})

test('targetCells picks a uniform cell size, cellsFromSize rounds up', () => {
  const lo = [0, 0, 0]
  const hi = [0.04, 0.02, 0.02] // 1.6e-5 m^3
  assert.equal(cellSizeFromTarget(lo, hi, 16000), 0.001)
  assert.deepEqual(cellsFromSize(lo, hi, 0.001), [40, 20, 20])
  assert.deepEqual(cellsFromSize(lo, hi, 0.003), [14, 7, 7])
  assert.throws(() => cellSizeFromTarget(lo, hi, 0), /targetCells must be a positive number/)
  assert.throws(() => cellsFromSize(lo, hi, 0), /cellSize must be a positive number of metres/)
})

test('scaleSuspicion asks above 100 mm and stays quiet below it', () => {
  const small = scaleSuspicion({ min: [0, 0, 0], max: [10, 10, 10] })
  assert.equal(small.suspicious, false)
  assert.equal(small.maxExtentMm, 10)

  const huge = scaleSuspicion({ min: [0, 0, 0], max: [150, 20, 20] })
  assert.equal(huge.suspicious, true)
  assert.match(huge.message, /assumeUnits/)
  assert.equal(scaleSuspicion({ min: [0, 0, 0], max: [60, 5, 5] }, { askAboveMm: 50 }).suspicious, true)
})

test('stlBboxMm reads the bbox of a real ASCII STL', () => {
  const dir = mkdtempSync(join(tmpdir(), 'domain-'))
  const file = writeAsciiStl(join(dir, 'box.stl'), boxTriangles([-5, -5, -5], [5, 5, 5]))
  const bbox = stlBboxMm(file)
  // STL numbers stay in millimetres: the project convention, and computeDomain converts them.
  assert.ok(Math.abs(bbox.max[0] - 5) < 1e-9, `max ${bbox.max[0]}`)
  assert.ok(Math.abs(bbox.min[0] + 5) < 1e-9)
  assert.equal(bbox.format, 'ascii')
})
