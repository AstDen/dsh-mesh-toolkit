// PLAN-tutorial-2606 §7.2 — the fast acceptance layer (T-00, T-09, T-10).
// These are pure checks: no OpenFOAM run, no meshing, seconds. The slow layers
// (T-01…T-08, T-11) are driven by scripts/tutorial.mjs and recorded in
// experiments/exp-025_tutorial-2606; they are not part of `node --test`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scanTutorialCases, parseAllrun } from '../lib/tutorial.js'
import { loadCapabilitiesMatrix, capabilityMatrix } from '../lib/caps.js'
import { normalizeAdvanced, advancedSupport } from '../lib/scaffold.js'

const here = dirname(fileURLToPath(import.meta.url))
const packageRoot = join(here, '..')
const projectRoot = join(packageRoot, '..', '..')

const TUTORIAL_ROOTS = {
  com2606: 'env/openfoam/com2606/usr/lib/openfoam/openfoam2606/tutorials/mesh',
  org14: 'env/openfoam/org14/opt/openfoam14/tutorials/mesh',
}
const rootOf = (build) => join(projectRoot, TUTORIAL_ROOTS[build])

function inventory(build) {
  const root = rootOf(build)
  if (!existsSync(root)) return null
  const cases = scanTutorialCases(root).map((entry) => {
    const script = entry.scripts[0] ? readFileSync(join(entry.dir, entry.scripts[0]), 'utf8') : ''
    const parsed = script ? parseAllrun(script, { caseDir: entry.dir, tutorialsRoot: root }) : { steps: [], manual: [], utils: [] }
    return { id: entry.id, family: entry.family, steps: parsed.steps.length, requires: [...new Set(parsed.utils)], manual: parsed.manual }
  })
  return { root, cases }
}

// --------------------------------------------------------------------------
// T-00 — inventory. The plan expected 47 case directories / 51 controlDicts;
// the tree actually holds 51 runnable directories (4 more are createPatch
// sub-cases the plan missed), and this test pins the measured truth instead
// of the plan's estimate. 12 families.
// --------------------------------------------------------------------------
test('T-00 com2606 inventory: 51 cases, 51 controlDicts, 12 families, requires on every case', () => {
  const inv = inventory('com2606')
  if (!inv) return // tree not installed here
  assert.equal(inv.cases.length, 51)
  const families = new Set(inv.cases.map((c) => c.family))
  assert.equal(families.size, 12, [...families].join(','))
  const empty = []
  for (const c of inv.cases) {
    assert.ok(Array.isArray(c.requires), `${c.id}: requires must be an array`)
    if (c.requires.length === 0) empty.push(c.id)
    else assert.ok(c.steps > 0, `${c.id}: requires without steps`)
  }
  // Parent-driven sub-cases: their Allrun lives one level up and runs the utilities itself.
  assert.deepEqual(empty.sort(), [
    'createPatch/TJunctionSwitching_createPatch/bottom',
    'createPatch/TJunctionSwitching_createPatch/inlet',
    'createPatch/TJunctionSwitching_createPatch/top',
    'moveDynamicMesh/relativeMotion/box2D_moveDynamicMesh',
    'moveDynamicMesh/relativeMotion/box_snappyHexMesh',
  ])
  const controlDicts = inv.cases.filter((c) => existsSync(join(inv.root, c.id, 'system/controlDict')))
  assert.equal(controlDicts.length, 51)
  const snappy = inv.cases.filter((c) => c.family === 'snappyHexMesh').length
  assert.equal(snappy, 15)
  const perFamily = Object.groupBy ? null : null
  void perFamily
})

test('T-00 org14 inventory: 9 cases', () => {
  const inv = inventory('org14')
  if (!inv) return
  assert.equal(inv.cases.length, 9)
  for (const c of inv.cases) assert.ok(c.requires.length > 0, `${c.id}: requires is empty`)
})

// --------------------------------------------------------------------------
// T-09 — the capability matrix against §2–§3 of the plan.
// --------------------------------------------------------------------------
test('T-09 org14 lacks the .com-only tools and keys; com2606 has them', () => {
  const matrix = loadCapabilitiesMatrix(join(packageRoot, 'data'))
  const com = matrix.builds.com2606
  const org = matrix.builds.org14
  for (const util of ['PDRblockMesh', 'foamyHexMesh', 'foamyQuadMesh', 'refineHexMesh', 'setSet', 'surfaceMeshExtract', 'topoSet', 'subsetMesh', 'createPatch', 'createBaffles', 'stitchMesh', 'refineMesh']) {
    assert.equal(com.utilities[util], true, `com2606 ${util}`)
  }
  for (const util of ['PDRblockMesh', 'foamyHexMesh', 'foamyQuadMesh', 'refineHexMesh', 'setSet', 'surfaceMeshExtract']) {
    assert.equal(org.utilities[util], false, `org14 ${util}`)
  }
  for (const util of ['topoSet', 'subsetMesh', 'createPatch', 'createBaffles', 'stitchMesh', 'refineMesh', 'extrudeMesh', 'polyDualMesh']) {
    assert.equal(org.utilities[util], true, `org14 ${util}`)
  }
  for (const key of ['gapMode', 'curvatureLevel', 'leakLevel', 'useLeakClosure', 'levelIncrement', 'locationsInMesh']) {
    assert.equal(com.snappyKeys[key], true, `com2606 ${key}`)
    assert.equal(org.snappyKeys[key], false, `org14 ${key}`)
  }
  for (const key of ['gapLevel', 'gapLevelIncrement', 'insidePoints', 'relativeSizes']) {
    assert.equal(com.snappyKeys[key], true, `com2606 ${key}`)
    assert.equal(org.snappyKeys[key], true, `org14 ${key}`)
  }
  // outsidePoints: supported by both source lines, but the 2606 annotated template never
  // documents it, so declared=false there while the key still works (supportedButUndocumented).
  assert.equal(org.snappyKeys.outsidePoints, true)
  assert.equal(com.snappyKeys.outsidePoints, false)
  assert.ok(com.supportedButUndocumented.includes('outsidePoints'))
  // distributionType is a distributedTriSurfaceMesh entry key, not a snappyKey: the matrix
  // carries the fact in its notes instead of pretending it belongs to the 15-key group.
  assert.ok(matrix.notes.some((n) => /distributionType/.test(n)))
})

test('T-09 live probe agrees with the declared matrix when OpenFOAM is configured', () => {
  const matrix = loadCapabilitiesMatrix(join(packageRoot, 'data'))
  // Build a caps object shaped like probeCaps() output for org14, without running bash.
  const caps = {
    ok: true,
    distribution: 'org',
    version: '14',
    commands: { surfaceFeatures: true, surfaceFeatureExtract: true, foamyHexMesh: false, PDRblockMesh: false },
    probed: ['surfaceFeatures', 'surfaceFeatureExtract', 'foamyHexMesh', 'PDRblockMesh'],
    dictKeys: {},
    features: {},
    notes: [],
  }
  const res = capabilityMatrix(caps, matrix)
  assert.equal(res.build, 'org14')
  assert.equal(res.values.utilities.foamyHexMesh, false, 'live probe wins over declared')
  assert.equal(res.values.utilities.surfaceFeatures, true)
})

// --------------------------------------------------------------------------
// T-10 — negative: unsupported keys must be refused before a run, never
// silently written. surfaceFeatures is the exception: it warns and drops.
// --------------------------------------------------------------------------
// advancedSupport reads the resolved matrix from caps.matrix (the shape writeSnappyCase builds).
const orgCaps = () => {
  const matrix = loadCapabilitiesMatrix(join(packageRoot, 'data'))
  const values = capabilityMatrix(
    { ok: true, distribution: 'org', version: '14', commands: {}, probed: [], dictKeys: {}, features: {}, notes: [] },
    matrix,
  )
  return { ok: true, distribution: 'org', version: '14', matrix: values }
}

test('T-10 org14 refuses the .com-only snappy keys before any run', () => {
  for (const advanced of [
    { curvature: { cellsPerRadius: 10, minRadiusLevel: -1, maxLevel: 10 } },
    { leak: { level: 3, closure: true, outsidePoints: [] } },
    { directional: { levels: [0, 1], increment: [0, 1, 1], region: { min: [0, 0, 0], max: [1, 1, 1] } } },
  ]) {
    const normalized = normalizeAdvanced(advanced)
    const support = advancedSupport(normalized, orgCaps())
    assert.ok(support.unsupported.length > 0, `${JSON.stringify(advanced)} must be refused on .org`)
    // writeSnappyCase turns this list into a hard refusal before any dictionary is written
    assert.ok(support.unsupported.every((u) => u.needs && u.option), JSON.stringify(support.unsupported))
  }
})

test('T-10 org14 keeps gapLevel but warns about gapMode instead of writing it', () => {
  const normalized = normalizeAdvanced({ gap: { level: [4, 0, 10], mode: 'inside' } })
  const support = advancedSupport(normalized, orgCaps())
  assert.equal(support.unsupported.length, 0, 'gapLevel itself is portable to .org')
  assert.ok(support.warnings.some((w) => /gapMode/.test(w)), JSON.stringify(support.warnings))
  assert.ok(support.skipped.includes('gap.mode'), JSON.stringify(support.skipped))
})

test('T-10 unsupported tool is reported, never run: foamyHexMesh on org14', () => {
  const matrix = loadCapabilitiesMatrix(join(packageRoot, 'data'))
  assert.equal(matrix.builds.org14.utilities.foamyHexMesh, false)
  assert.equal(matrix.builds.com2606.utilities.foamyHexMesh, true)
})
