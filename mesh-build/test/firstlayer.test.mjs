import test from 'node:test'
import assert from 'node:assert/strict'

import {
  RE_TRANSITION,
  CELL_THICKNESS_FACTOR,
  cfModel,
  computeFirstLayer,
  firstLayerFromYPlus,
  skinFriction,
  yPlusFromThickness,
  yPlusFromShear,
} from '../lib/firstlayer.js'

const TURBULENT = { uRef: 10, lRef: 1, nu: 1.5e-5, yPlusTarget: 1 } // Re = 666 667

test('D-5 the first cell is twice the wall distance that carries the y+ target', () => {
  const r = computeFirstLayer(TURBULENT)
  assert.equal(r.formula.cfModel, 'turbulent-1/7')
  assert.equal(r.formula.regime, 'turbulent')
  assert.equal(r.formula.cellThicknessFactor, CELL_THICKNESS_FACTOR)
  assert.equal(r.formula.legacy, false)
  // the correlation itself is unchanged and still exact
  assert.ok(Math.abs(r.Cf - 0.026 * Math.pow(r.Re, -1 / 7)) < 1e-15)
  assert.ok(Math.abs(r.uTau - 10 * Math.sqrt(r.Cf / 2)) < 1e-12)
  assert.ok(Math.abs(r.wallDistance_m - (1 * 1.5e-5) / r.uTau) < 1e-18)
  assert.ok(Math.abs(r.firstLayer_m - 2 * r.wallDistance_m) < 1e-18)
  assert.ok(Math.abs(r.yPlusFirst - 1) < 1e-12)
})

test('D-5 legacyYPlus reproduces the pre-1.3 numbers exactly', () => {
  const modern = computeFirstLayer(TURBULENT)
  const legacy = computeFirstLayer({ ...TURBULENT, legacyYPlus: true })
  assert.equal(legacy.formula.legacy, true)
  assert.equal(legacy.formula.cellThicknessFactor, 1)
  assert.ok(Math.abs(modern.firstLayer_m / legacy.firstLayer_m - 2) < 1e-12)
  assert.ok(Math.abs(legacy.firstLayer_m - (TURBULENT.yPlusTarget * TURBULENT.nu) / legacy.uTau) < 1e-18)
  assert.match(legacy.notes.join(' '), /legacyYPlus/)
})

test('D-5 below Re 5e5 the laminar Blasius Cf is used instead of the turbulent law', () => {
  assert.equal(cfModel(4.99e5), 'laminar-blasius')
  assert.equal(cfModel(RE_TRANSITION), 'turbulent-1/7')
  assert.equal(cfModel(1e6), 'turbulent-1/7')

  const laminarRe = 1e5
  const cf = skinFriction(laminarRe)
  assert.ok(Math.abs(cf - 0.664 / Math.sqrt(laminarRe)) < 1e-15)
  assert.notEqual(cf, 0.026 * Math.pow(laminarRe, -1 / 7))

  const r = computeFirstLayer({ uRef: 1, lRef: 1.5, nu: 1.5e-5, yPlusTarget: 1 }) // Re = 1e5
  assert.equal(r.formula.regime, 'laminar')
  assert.equal(r.Cf, cf)
  assert.match(r.notes.join(' '), /laminar Blasius/)
  // legacy keeps the turbulent law even in the laminar range
  const legacy = computeFirstLayer({ uRef: 1, lRef: 1.5, nu: 1.5e-5, yPlusTarget: 1, legacyYPlus: true })
  assert.equal(legacy.formula.cfModel, 'turbulent-1/7')
})

test('D-5 the first cell is clamped to half the near-wall cell, with the resulting y+ reported', () => {
  const cellSize = 1e-4 // 100 µm → the clamp is 50 µm
  const r = computeFirstLayer({ ...TURBULENT, cellSize })
  assert.equal(r.clamped, true)
  assert.equal(r.firstLayer_m, 0.5 * cellSize)
  assert.ok(r.firstLayerRequested_m > r.firstLayer_m)
  assert.ok(Math.abs(r.yPlusFirst - 0.72917) < 1e-4, `y+ ${r.yPlusFirst}`)
  assert.match(r.notes.join(' '), /clamped to/)

  const roomy = computeFirstLayer({ ...TURBULENT, cellSize: 1e-3 })
  assert.equal(roomy.clamped, false)
  assert.equal(roomy.firstLayer_m, roomy.firstLayerRequested_m)
})

test('the layer stack and the scaffoldOptions block follow the corrected first layer', () => {
  const r = computeFirstLayer({ ...TURBULENT, cellSize: 4e-4, layerSurfaces: ['walls'] })
  assert.ok(r.nLayers >= 1)
  assert.ok(Math.abs(r.lastLayer_m - r.firstLayer_m * Math.pow(1.2, r.nLayers - 1)) < 1e-18)
  assert.equal(r.scaffoldOptions.layerSurfaces[0], 'walls')
  assert.equal(r.scaffoldOptions.nLayers, r.nLayers)
  assert.equal(r.scaffoldOptions.layerThicknessRelative, true)
  assert.ok(Math.abs(r.scaffoldOptions.layerThickness - r.lastLayer_m / 4e-4) < 1e-12)
  assert.ok(Math.abs(r.scaffoldOptions.minVol - Math.pow(r.firstLayer_m, 3) / 6) < 1e-24)
})

test('the inverse reports y+ at the centroid and the full-height value separately', () => {
  const forward = computeFirstLayer(TURBULENT)
  const back = yPlusFromThickness({ uRef: 10, lRef: 1, nu: 1.5e-5, firstLayer: forward.firstLayer_m })
  assert.ok(Math.abs(back.yPlus - 1) < 1e-9)
  assert.ok(Math.abs(back.yPlusCellHeight - 2) < 1e-9)
  assert.equal(back.formula.cellThicknessFactor, 2)

  const legacy = yPlusFromThickness({ uRef: 10, lRef: 1, nu: 1.5e-5, firstLayer: forward.firstLayer_m, legacyYPlus: true })
  assert.ok(Math.abs(legacy.yPlus - 2) < 1e-9)
  assert.equal(legacy.formula.legacy, true)

  const shear = yPlusFromShear({ uTau: 0.4, firstLayer: 5e-5, nu: 1.5e-5 })
  assert.ok(Math.abs(shear.yPlus - (5e-5 * 0.4) / 1.5e-5) < 1e-12)
})

test('firstLayerFromYPlus keeps the feedback contract and accepts the legacy flag', () => {
  const modern = firstLayerFromYPlus({ yPlus: 45, uRef: 10, lRef: 1, nu: 1.5e-5 })
  const legacy = firstLayerFromYPlus({ yPlus: 45, uRef: 10, lRef: 1, nu: 1.5e-5, legacyYPlus: true })
  assert.equal(modern.input.yPlusTarget, 45)
  assert.ok(Math.abs(modern.firstLayer_m / legacy.firstLayer_m - 2) < 1e-12)
})

test('invalid input is refused instead of silently defaulted', () => {
  assert.throws(() => computeFirstLayer({ uRef: 0, lRef: 1 }), /uRef must be a positive number/)
  assert.throws(() => computeFirstLayer({ uRef: 1, lRef: 1, expansionRatio: 1 }), /expansionRatio must be > 1/)
  assert.throws(() => computeFirstLayer({ uRef: 1, lRef: 1, coverage: 1.5 }), /coverage must be in \(0, 1\]/)
  assert.throws(() => computeFirstLayer({ ...TURBULENT, cellSize: -1 }), /cellSize must be a positive number/)
  assert.throws(() => skinFriction(0), /Re must be a positive number/)
  assert.throws(() => skinFriction(1e6, { model: 'spalding' }), /unknown skin-friction model/)
})
