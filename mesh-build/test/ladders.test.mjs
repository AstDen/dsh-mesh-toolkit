/**
 * Unit tests for the 1.2.0 advice ladders (plan S3, audit D-9): every category can step at least
 * twice, and each second rung maps to a real revision the plugin can execute.
 *
 * The rung index comes from the revision history (`Math.min(state.same, ladder.length - 1)`), so a
 * second rung needs one recorded revision of the same category in the handoff.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadAdvice, planRevision } from '../lib/revise.js'

const here = dirname(fileURLToPath(import.meta.url))
const loaded = loadAdvice(join(here, '..', 'data'))
if (loaded.error) throw new Error(loaded.error)
const { advice } = loaded

const handoff = (category, overrides = {}) => ({
  schemaVersion: 'mesh-handoff/1',
  route: 'snappy',
  mesh: {
    cells: 148288,
    selection: { cells: [59, 46, 46], cellSize_m: 0.001 },
    layers: { nLayers: 3, expansionRatio: 1.5, minThickness: 0.0005 },
  },
  geometry: { stls: ['case/constant/triSurface/cube.stl'] },
  patches: [{ name: 'cube', role: 'wall' }],
  quality: { verdict: 'FAIL', minVol: 1e-14, failing: [category] },
  // the rung index counts `history` entries with event "revision" for this category
  history: category ? [{ event: 'revision', strategy: 'ladder', category, attempt: 1, verdict: 'FAIL' }] : [],
  ...overrides,
})

const feedback = (category, evidence = {}) => ({
  schemaVersion: 'mesh-feedback/1',
  category,
  severity: 'major',
  evidence: { metrics: { maxNonOrtho: 71.5, ...evidence } },
  changes: {},
})

const plan = (category, evidence, attempt = 2) => planRevision({ feedback: feedback(category, evidence), handoff: handoff(category), advice, attempt })

test('every advice category declares a ladder, a ceiling and an op name', () => {
  assert.equal(Object.keys(advice.categories).length, 10)
  for (const [name, category] of Object.entries(advice.categories)) {
    assert.ok(Array.isArray(category.ladder) && category.ladder.length >= 1, `${name} has no ladder`)
    assert.ok(Number(category.ceiling) >= 1, `${name} has no ceiling`)
    for (const rung of category.ladder) assert.match(rung.op, /^[a-z][A-Za-z.-]+$/)
  }
})

test('every escalating category offers at least two rungs', () => {
  const two = Object.entries(advice.categories).filter(([, c]) => c.ladder.length >= 2).map(([k]) => k).sort()
  assert.deepEqual(two, ['cells-budget', 'domain', 'layers', 'nonortho', 'resolution', 'skewness', 'yplus'])
})

test('D-9: the second layers rung thins the first layer and the growth', () => {
  const result = plan('layers')
  assert.equal(result.ok, true, JSON.stringify(result.problems))
  assert.equal(result.rung, 1)
  assert.equal(result.actions[0].op, 'layers.thickness')
  assert.equal(result.request.scaffoldOptions.expansionRatio, 1.05) // 1.5 * 0.7
  assert.equal(result.request.scaffoldOptions.minThickness, 0.00025)
})

test('D-9: the second skewness rung smooths the snap instead of refining', () => {
  const result = plan('skewness')
  assert.equal(result.rung, 1)
  assert.equal(result.actions[0].op, 'snap.smooth')
  assert.deepEqual(result.request.snapControls, { nSolveIter: 8, nRelaxIter: 8 })
})

test('D-9: the second y+ rung relaxes the target', () => {
  const result = plan('yplus', { yPlusMax: 45, yPlusTarget: 1, uRef: 10, lRef: 0.01, nu: 1.5e-5 })
  assert.equal(result.rung, 1)
  assert.equal(result.actions[0].op, 'layers.yplusRelax')
  assert.equal(result.request.scaffoldOptions.yPlusTarget, 2)
})

test('D-9: the second domain rung switches the domain mode', () => {
  const result = plan('domain')
  assert.equal(result.rung, 1)
  assert.equal(result.actions[0].op, 'domain.mode')
  assert.equal(result.request.scaffoldOptions.domain.type, 'wrap')
})

test('D-9: the second resolution rung halves the cells', () => {
  const result = plan('resolution')
  assert.equal(result.rung, 1)
  assert.equal(result.actions[0].op, 'sizing.scale')
  assert.match(result.actions[0].action, /x0\.5/)
})

test('D-9: the ceiling still escalates instead of repeating a rung', () => {
  const result = plan('layers', {}, 3)
  assert.equal(result.ok, false)
  assert.equal(result.escalated, true)
  assert.match(result.problems[0], /above the ceiling/)
  assert.ok(result.options.length >= 2)
})
