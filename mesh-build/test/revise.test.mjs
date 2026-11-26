import test from 'node:test'
import assert from 'node:assert/strict'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  FEEDBACK_SCHEMA,
  attemptState,
  loadAdvice,
  planRevision,
  validateFeedback,
} from '../lib/revise.js'
import { feedbackFixture, handoffFixture } from './helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const { advice, error } = loadAdvice(join(here, '..', 'data'))

test('the advice table loads and covers the contract categories', () => {
  assert.equal(error, undefined)
  assert.deepEqual(Object.keys(advice.categories).sort(), [
    'cells-budget', 'domain', 'layers', 'nonortho', 'patch-roles',
    'resolution', 'skewness', 'stl-quality', 'units', 'yplus',
  ])
  for (const [name, spec] of Object.entries(advice.categories)) {
    assert.ok(Array.isArray(spec.ladder) && spec.ladder.length > 0, `${name} has no ladder`)
    assert.ok(Number.isFinite(Number(spec.ceiling)), `${name} has no ceiling`)
    for (const rung of spec.ladder) assert.equal(typeof rung.op, 'string', `${name} rung without op`)
  }
  assert.deepEqual(advice.routeDowngrade.categories, ['nonortho', 'skewness'])
  assert.equal(advice.routeDowngrade.afterConsecutive, 3)
  assert.equal(advice.routeDowngrade.to, 'cfmesh')
})

test('loadAdvice reports a missing table instead of throwing', () => {
  const missing = loadAdvice(join(here, '..', 'data', 'nope'))
  assert.match(missing.error, /advice table not found/)
})

test('validateFeedback names the schema, the category and the severity', () => {
  assert.deepEqual(validateFeedback(feedbackFixture('domain'), advice), [])
  assert.match(validateFeedback({ category: 'domain' }, advice).join(' '), /schemaVersion must be "mesh-feedback\/1"/)
  assert.match(validateFeedback(feedbackFixture('wobble'), advice).join(' '), /unknown category "wobble"/)
  assert.match(validateFeedback(feedbackFixture('domain', { severity: 'epic' }), advice).join(' '), /severity must be blocker\|major\|minor/)
  assert.deepEqual(validateFeedback(null, advice), ['feedback must be an object (mesh-feedback/1)'])
  assert.equal(FEEDBACK_SCHEMA, 'mesh-feedback/1')
})

test('attemptState counts revisions of one category and trailing failures', () => {
  const history = [
    { event: 'revision', category: 'nonortho', verdict: 'FAIL' },
    { event: 'revision', category: 'nonortho', verdict: 'FAIL' },
    { event: 'gate', verdict: 'PASS' },
    { event: 'revision', category: 'nonortho', verdict: 'FAIL' },
  ]
  const state = attemptState({ history }, 'nonortho')
  assert.equal(state.same, 3)
  assert.equal(state.consecutive, 3)
  assert.equal(state.lastVerdict, 'FAIL')
  assert.equal(attemptState({ history }, 'skewness').same, 0)
  assert.equal(attemptState({}, 'nonortho').consecutive, 0)

  const recovered = [{ event: 'revision', category: 'nonortho', verdict: 'PASS' }, { event: 'revision', category: 'nonortho', verdict: 'FAIL' }]
  assert.equal(attemptState({ history: recovered }, 'nonortho').consecutive, 1)
})

test('the first resolution plan scales the background cells', () => {
  const plan = planRevision({ feedback: feedbackFixture('resolution'), handoff: handoffFixture(), advice })
  assert.equal(plan.ok, true)
  assert.equal(plan.strategy, 'ladder')
  assert.equal(plan.rung, 0)
  assert.equal(plan.actions[0].op, 'sizing.scale')
  assert.deepEqual(plan.request.scaffoldOptions.cells, [57, 46, 46]) // round(40/0.7), round(32/0.7)
  assert.ok(plan.actions[0].predictedCells > 40960)
})

test('the ladder advances with the revisions already recorded', () => {
  const handoff = handoffFixture({ history: [{ event: 'revision', category: 'nonortho', verdict: 'FAIL' }] })
  const plan = planRevision({ feedback: feedbackFixture('nonortho'), handoff, advice })
  assert.equal(plan.ok, true)
  assert.equal(plan.rung, 1)
  assert.equal(plan.actions[0].op, 'layers.reduceLayers')
  assert.equal(plan.request.scaffoldOptions.nLayers, 2) // 3 -> 2
})

test('stl-quality is a stop, not a parameter change', () => {
  const plan = planRevision({ feedback: feedbackFixture('stl-quality'), handoff: handoffFixture(), advice })
  assert.equal(plan.ok, true)
  assert.equal(plan.stop, 'stl-quality')
  assert.match(plan.actions[0].action, /stl_check/)
  assert.deepEqual(plan.request, {})
})

test('an op that needs evidence refuses instead of guessing', () => {
  const noMetrics = planRevision({ feedback: feedbackFixture('yplus'), handoff: handoffFixture(), advice })
  assert.equal(noMetrics.ok, false)
  assert.match(noMetrics.problems.join(' '), /yplus: uTau needs uRef \(m\/s\) and lRef \(m\)/)

  const withMetrics = planRevision({
    feedback: feedbackFixture('yplus', { evidence: { metrics: { uRef: 10, lRef: 0.01, nu: 1.5e-5 } } }),
    handoff: handoffFixture(),
    advice,
  })
  assert.equal(withMetrics.ok, true)
  assert.ok(withMetrics.request.scaffoldOptions.nLayers >= 1)

  const units = planRevision({ feedback: feedbackFixture('units'), handoff: handoffFixture(), advice })
  assert.equal(units.ok, false)
  assert.match(units.problems.join(' '), /units\.confirm needs feedback\.changes\.scale/)
})

test('the ceiling returns escalation options instead of repeating parameters', () => {
  const history = Array.from({ length: 3 }, () => ({ event: 'revision', category: 'resolution', verdict: 'FAIL' }))
  const plan = planRevision({ feedback: feedbackFixture('resolution'), handoff: handoffFixture({ history }), advice })
  assert.equal(plan.ok, false)
  assert.equal(plan.escalated, true)
  assert.match(plan.problems.join(' '), /above the ceiling 2 for "resolution"/)
  assert.ok(plan.options.length >= 2)
  for (const option of plan.options) {
    assert.ok(option.id && option.label && option.cost && option.effect, 'every option needs id/label/cost/effect')
  }
})

test('three consecutive nonortho failures downgrade the route once', () => {
  const history = Array.from({ length: 3 }, () => ({ event: 'revision', category: 'nonortho', verdict: 'FAIL' }))
  const plan = planRevision({ feedback: feedbackFixture('nonortho'), handoff: handoffFixture({ history }), advice })
  assert.equal(plan.ok, true)
  assert.equal(plan.strategy, 'route-downgrade')
  assert.deepEqual(plan.actions[0], { op: 'route.switch', from: 'snappy', to: 'cfmesh', reason: advice.routeDowngrade.reason })
  assert.equal(plan.request.route, 'cfmesh')

  const already = handoffFixture({ history: [...history, { event: 'revision', category: 'nonortho', verdict: 'FAIL', strategy: 'route-downgrade' }] })
  const second = planRevision({ feedback: feedbackFixture('nonortho'), handoff: already, advice })
  assert.notEqual(second.strategy, 'route-downgrade', 'the downgrade may happen only once')
})

test('a cfMesh route does not downgrade to cfMesh', () => {
  const history = Array.from({ length: 3 }, () => ({ event: 'revision', category: 'skewness', verdict: 'FAIL' }))
  const handoff = handoffFixture({ mesh: { route: 'cfmesh' }, history })
  const plan = planRevision({ feedback: feedbackFixture('skewness'), handoff, advice })
  assert.notEqual(plan.strategy, 'route-downgrade')
})
