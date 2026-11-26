#!/usr/bin/env node
/**
 * Contract tests for the workbench handoff (docs/WORKBENCH-CONTRACT.md §7, plan A9).
 *
 * Three tiers, each independent, so the script is useful everywhere:
 *
 *   1. library tier — always runs: the `meshToolkit` service, the handoff schema, role aliases,
 *      the advice table, domain/unit suspicion. No DSH, no OpenFOAM, no node_modules.
 *   2. tool tier — runs when the plugin packages can be imported (dev symlink to the DSH checkout):
 *      the real tool handlers on a fake Cordis context.
 *   3. OpenFOAM tier — runs when a bashrc resolves: real snappy builds for T1/T2/T5/T6 and a delivery (T7).
 *   4. workbench tier — runs when @yakovlev-i-a/dsh-openfoam-workbench is installed: its openfoam_case_scaffold
 *      takes the delivered case (the M3 seam) and must add system/fvSchemes + 0/ without hand edits.
 *
 * Every skipped tier prints `SKIP` with the reason and does not fail the run, so CI stays green on a
 * machine without OpenFOAM while a developer machine exercises the whole contract.
 *
 * Usage:
 *   node scripts/contract-test.mjs            # all available tiers
 *   node scripts/contract-test.mjs --no-mesh  # skip the OpenFOAM tier explicitly
 *   node scripts/contract-test.mjs --verbose
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// Two supported layouts: the development checkout (plugins/<pkg>) and the published repository (<pkg>).
const PKG = existsSync(join(REPO, 'plugins', 'sim-core')) ? join(REPO, 'plugins') : REPO
const VERBOSE = process.argv.includes('--verbose')
const NO_MESH = process.argv.includes('--no-mesh')

const results = []
function check(tier, id, name, ok, detail = '') {
  results.push({ tier, id, name, ok: Boolean(ok), detail })
  console.log(`${ok ? 'ok  ' : 'FAIL'} [${tier}/${id}] ${name}${detail ? ' — ' + detail : ''}`)
  return Boolean(ok)
}
/**
 * A check for work that lives in another repository (the workbench side of the seam). It stays green in the
 * summary so a red suite keeps meaning "our side broke", and turns into a hard failure with
 * CONTRACT_TEST_REQUIRE_WORKBENCH=1 once the author has shipped the fix.
 */
const REQUIRE_WORKBENCH = process.env.CONTRACT_TEST_REQUIRE_WORKBENCH === '1'
function known(tier, id, name, ok, detail = '') {
  const hard = REQUIRE_WORKBENCH
  results.push({ tier, id, name, ok: Boolean(ok) || !hard, detail, known: true })
  const tag = ok ? 'ok  ' : hard ? 'FAIL' : 'known-gap'
  console.log(`${tag} [${tier}/${id}] ${name}${detail ? ' — ' + detail : ''}`)
  return Boolean(ok)
}
function skip(tier, reason) {
  results.push({ tier, id: 'skip', name: `skipped ${tier}`, ok: true, detail: reason, skipped: true })
  console.log(`SKIP [${tier}] ${reason}`)
}
const log = (...args) => { if (VERBOSE) console.log('      ', ...args) }

/** A closed axis-aligned box as an ASCII STL (12 triangles, outward normals) — no dependencies. */
function boxStl(x, y, z, lx, ly, lz) {
  const v = [
    [x, y, z], [x + lx, y, z], [x + lx, y + ly, z], [x, y + ly, z],
    [x, y, z + lz], [x + lx, y, z + lz], [x + lx, y + ly, z + lz], [x, y + ly, z + lz],
  ]
  const quads = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
  const lines = ['solid box']
  for (const [a, b, c, d] of quads) {
    for (const tri of [[a, b, c], [a, c, d]]) {
      const [p1, p2, p3] = tri.map((i) => v[i])
      const u = [p2[0] - p1[0], p2[1] - p1[1], p2[2] - p1[2]]
      const w = [p3[0] - p1[0], p3[1] - p1[1], p3[2] - p1[2]]
      const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
      const len = Math.hypot(...n) || 1
      lines.push(`facet normal ${n[0] / len} ${n[1] / len} ${n[2] / len}`, 'outer loop')
      for (const p of [p1, p2, p3]) lines.push(`vertex ${p[0]} ${p[1]} ${p[2]}`)
      lines.push('endloop', 'endfacet')
    }
  }
  lines.push('endsolid box')
  return lines.join('\n') + '\n'
}

const lib = (pkg, file) => import(pathToFileURL(join(PKG, pkg, file)).href)

// ---------------------------------------------------------------------------------------------
// tier 1: library
// ---------------------------------------------------------------------------------------------
console.log('\n== library tier ==')

const { ensureToolkit, TOOLKIT_API_VERSION } = await lib('sim-core', 'lib/toolkit.js')
const { buildHandoff, validateHandoff, writeHandoff, readHandoff, patchRole, PATCH_ROLES } = await lib('sim-core', 'lib/handoff.js')
const { ROLE_ALIASES, normalizeRoles, planRetype } = await lib('mesh-build', 'lib/patchtypes.js')
const { loadAdvice, planRevision, validateFeedback } = await lib('mesh-build', 'lib/revise.js')
const { scaleSuspicion } = await lib('mesh-build', 'lib/domain.js')

// T-service: the service answers with an apiVersion and structured refusals, never throws.
{
  const ctx = {
    _services: new Map(),
    get(name) { return this._services.get(name) ?? null },
    provide(name, api) { this._services.set(name, api); return { dispose: () => this._services.delete(name) } },
  }
  const service = ensureToolkit(ctx)
  const caps = service.capabilities()
  check('lib', 'S1', 'meshToolkit advertises apiVersion 1', caps.apiVersion === TOOLKIT_API_VERSION && Number.isInteger(caps.apiVersion), `apiVersion ${caps.apiVersion}`)
  check('lib', 'S2', 'capabilities list present and absent methods', Array.isArray(caps.methods) && Array.isArray(caps.missing), `provided [${caps.methods.join(',')}] missing [${caps.missing.join(',')}]`)
  // an absent method must be a structured answer, not a throw — this is what lets the workbench fall back
  const absent = await service.call('patchTypes', { caseDir: '.', roles: {} })
  check('lib', 'S3', 'absent method answers not-provided with a hint', absent.ok === false && absent.error === 'not-provided' && typeof absent.hint === 'string', absent.error)
  service.register('gate', async () => ({ ok: true, verdict: 'PASS' }), { plugin: 'contract-test' })
  const answered = await service.gate({ caseDir: '.' })
  check('lib', 'S4', 'registered method is callable through the typed shim', answered.ok === true && answered.verdict === 'PASS', answered.verdict)
  service.register('gate', async () => { throw new Error('boom') }, { plugin: 'contract-test' })
  const threw = await service.gate({})
  check('lib', 'S5', 'a throwing provider becomes a structured error', threw.ok === false && threw.error === 'exception' && /boom/.test(threw.message), threw.error)
  check('lib', 'S6', 'the service is a singleton on one context', ensureToolkit(ctx) === service)
}

// T-handoff: the schema is validated, not trusted.
{
  const handoff = buildHandoff({
    caseDir: join(REPO, 'no-such-case'),
    producer: { plugin: 'mesh-build', version: '0.7.4' },
    units: { stl: 'mm', case: 'm', scale: 0.001 },
    mesh: { route: 'snappy', cells: 1000 },
    quality: { profile: 'project', minVol: 1e-12, verdict: 'PASS' },
    patches: [
      { region: null, name: 'inlet', type: 'patch', nFaces: 10 },
      { region: null, name: 'walls', type: 'wall', nFaces: 20 },
    ],
  })
  const problems = validateHandoff(handoff)
  check('lib', 'H1', 'handoff validates and carries the schema version', problems.length === 0 && handoff.schemaVersion === 'mesh-handoff/1', problems.join('; ') || handoff.schemaVersion)
  check('lib', 'H2', 'patch roles are derived from the type', patchRole({ name: 'walls', type: 'wall' }) === 'wall' && handoff.patches.every((p) => PATCH_ROLES.includes(p.role)), handoff.patches.map((p) => `${p.name}:${p.role}`).join(','))
  const failedGate = validateHandoff({ ...handoff, quality: { ...handoff.quality, verdict: 'FAIL' } })
  check('lib', 'H3', 'a failing gate is refused by the validator', failedGate.length > 0 && failedGate.some((m) => /verdict is FAIL/.test(m)), failedGate.join('; '))
  const metreCase = validateHandoff({ ...handoff, units: { ...handoff.units, case: 'mm' } })
  check('lib', 'H4', 'a case measured in mm is refused', metreCase.some((m) => /units\.case/.test(m)), metreCase.join('; '))
  const badRole = validateHandoff({ ...handoff, patches: [{ ...handoff.patches[0], role: 'wallpaper' }] })
  check('lib', 'H5', 'an unknown role is refused', badRole.some((m) => /not in the enumeration/.test(m)), badRole.join('; '))
}

// T5-library: plural role keys are accepted (the contract's next[] uses `walls`) and refusals are structured.
{
  const normalized = normalizeRoles({ inlets: ['inlet'], outlets: ['outlet'], walls: ['walls', 'obstacle'], symmetry: ['world'] })
  const mapped = Object.fromEntries(normalized.out.map((o) => [o.name, o.role]))
  check('lib', 'R1', 'plural role aliases normalise',
    normalized.problems.length === 0
      && mapped.inlet === 'inlet' && mapped.outlet === 'outlet'
      && mapped.walls === 'wall' && mapped.obstacle === 'wall' && mapped.world === 'symmetry'
      && ROLE_ALIASES.walls === 'wall',
    JSON.stringify(mapped))
  const manual = normalizeRoles({ cyclic: ['back'] })
  check('lib', 'R2', 'cyclic is refused as manual setup, not guessed', manual.problems.some((p) => p.code === 'needs-manual-setup'), manual.problems.map((p) => p.code).join(','))

  // a synthetic one-patch case: planRetype must refuse conflicts and unknown patches without writing anything
  const fixture = mkdtempSync(join(tmpdir(), 'contract-roles-'))
  try {
    const meshDir = join(fixture, 'constant', 'polyMesh')
    mkdirSync(meshDir, { recursive: true })
    writeFileSync(join(meshDir, 'boundary'), `FoamFile { version 2.0; format ascii; class polyBoundaryMesh; object boundary; }
1
(
    walls
    {
        type wall;
        inGroups 1(wall);
        nFaces 6;
        startFace 0;
    }
)
`)
    const conflict = planRetype({ caseDir: fixture, roles: { inlet: ['walls'], outlet: ['walls'] } })
    check('lib', 'R3', 'one patch in two roles is refused', conflict.ok === false && conflict.problems.some((p) => p.code === 'role-conflict'), conflict.problems.map((p) => p.code).join(','))
    const missing = planRetype({ caseDir: fixture, roles: { wall: ['nope'] } })
    check('lib', 'R4', 'an unknown patch is refused with the available names', missing.ok === false && missing.problems.some((p) => p.code === 'patch-not-found' && /walls \(wall\)/.test(p.message)), missing.problems[0]?.message)
    const ok = planRetype({ caseDir: fixture, roles: { walls: ['walls'] } })
    check('lib', 'R5', 'a known patch plans an unchanged change set', ok.ok === true && Array.isArray(ok.changes), `${ok.changes?.length ?? 0} changes, notes ${ok.notes?.length ?? 0}`)
  } finally {
    rmSync(fixture, { recursive: true, force: true })
  }
}

// T2-library: the advice table is data and the ceiling escalates instead of repeating.
{
  const { advice } = loadAdvice(join(PKG, 'mesh-build', 'data'))
  check('lib', 'A1', 'advice table loads with all contract categories', ['yplus', 'nonortho', 'skewness', 'patch-roles', 'resolution', 'domain', 'units', 'layers', 'cells-budget', 'stl-quality'].every((c) => advice.categories[c]), Object.keys(advice.categories).length + ' categories')
  const feedback = {
    schemaVersion: 'mesh-feedback/1', requestId: 'contract', attempt: 1, category: 'yplus', severity: 'major',
    evidence: { metrics: { yPlusMax: 40, uRef: 10, lRef: 0.01, nu: 1.5e-5 } },
  }
  const valid = validateFeedback(feedback, advice)
  check('lib', 'A2', 'a valid feedback document passes validation', valid.ok !== false, JSON.stringify(valid.problems ?? []))
  const handoff = { history: [], quality: { minVol: 8e-13 }, mesh: { route: 'snappy', selection: { cells: [20, 20, 20] } }, domain: { bbox_m: { min: [0, 0, 0], max: [0.01, 0.01, 0.01] } }, patches: [], recommendations: {} }
  const plan = planRevision({ feedback, handoff, advice, attempt: 1 })
  check('lib', 'A3', 'yplus feedback yields a layer plan', plan.ok === true && plan.request?.scaffoldOptions?.nLayers > 0 && plan.request.scaffoldOptions.layerThickness > 0, `nLayers ${plan.request?.scaffoldOptions?.nLayers}`)
  const escalated = planRevision({ feedback: { ...feedback, attempt: 9 }, handoff: { ...handoff, history: [] }, advice, attempt: 9 })
  check('lib', 'A4', 'beyond the ceiling it escalates with options', escalated.ok === false && escalated.escalated === true && Array.isArray(escalated.options) && escalated.options.length >= 2, `${escalated.options?.length} options`)
  const downgrade = planRevision({
    feedback: { ...feedback, category: 'nonortho', attempt: 4 },
    handoff: { ...handoff, history: [
      { event: 'revision', attempt: 1, category: 'nonortho', verdict: 'FAIL' },
      { event: 'revision', attempt: 2, category: 'nonortho', verdict: 'FAIL' },
      { event: 'revision', attempt: 3, category: 'nonortho', verdict: 'FAIL' },
    ] },
    advice,
    attempt: 4,
  })
  check('lib', 'A5', 'three consecutive failures downgrade the route instead of repeating', downgrade.strategy === 'route-downgrade' && downgrade.request?.route === 'cfmesh', downgrade.strategy)
}

// T4-library: metre-sized geometry is questioned, not silently trimmed.
{
  const big = scaleSuspicion({ min: [0, 0, 0], max: [150, 40, 40] }, { askAboveMm: 100 })
  const small = scaleSuspicion({ min: [0, 0, 0], max: [10, 10, 10] }, { askAboveMm: 100 })
  check('lib', 'U1', 'a 150 mm bbox is suspicious', big.suspicious === true, big.message)
  check('lib', 'U2', 'a 10 mm bbox is not', small.suspicious === false)
}

// ---------------------------------------------------------------------------------------------
// tier 2: tools on a fake Cordis context (needs the dev node_modules symlink)
// ---------------------------------------------------------------------------------------------
console.log('\n== tool tier ==')

let tools = null
try {
  const registry = new Map()
  const ctx = {
    tools: { register: (tool) => { registry.set(tool.name, tool); return { dispose: () => registry.delete(tool.name) } }, get: () => null },
    _services: new Map(),
    get(name) { return this._services.get(name) ?? null },
    provide(name, api) { this._services.set(name, api); return { dispose: () => this._services.delete(name) } },
    setInterval: () => 0,
    clearInterval: () => {},
    on: () => {},
    effect: () => {},
    systemPrompt: { mount: () => ({ dispose: () => {} }) },
    skills: { register: () => ({ dispose: () => {} }) },
  }
  for (const pkg of ['mesh-stl', 'mesh-build']) {
    const mod = await import(pathToFileURL(join(PKG, pkg, 'index.js')).href)
    mod.apply(ctx, {})
  }
  const exec = { agent: { cwd: REPO } }
  tools = {
    names: [...registry.keys()].sort(),
    call: async (name, args) => registry.get(name).execute(args, exec),
    service: ctx.get('meshToolkit'),
  }
  check('tool', 'T0', 'both packages register their tools', tools.names.includes('mesh_build') && tools.names.includes('stl_check') && tools.names.includes('mesh_revise'), `${tools.names.length} tools`)
} catch (error) {
  skip('tool', `plugin packages cannot be imported here (${String(error.message).slice(0, 120)}); link plugins/*/node_modules to a DSH checkout to run this tier`)
}

if (tools) {
  const work = mkdtempSync(join(tmpdir(), 'contract-'))
  const caseDir = join(work, 'case')
  try {
    // T4 through the tool: an ambiguous 150-unit bbox must ask about units instead of silently scaling.
    // 150 units is either a 150 mm part (mm, the project convention) or a 150 m part (metres) — the tool cannot
    // know, and guessing wrong makes every margin and cell size 1000x off, which snappy would answer by clipping.
    const ambiguousStl = join(work, 'ambiguous.stl')
    writeFileSync(ambiguousStl, boxStl(0, 0, 0, 150, 40, 40))
    const units = await tools.call('mesh_build', {
      route: 'snappy', caseDir, scaffold: true, stl: [ambiguousStl], dryRun: true,
      scaffoldOptions: { domain: { type: 'external' }, targetCells: 20000, locationInMesh: [0, 0, 0] },
    })
    check('tool', 'T4', 'an ambiguous 150-unit STL asks for units instead of clipping',
      units.ok === false && Array.isArray(units.needs_input) && units.needs_input[0]?.id === 'geometry-units',
      units.phase ?? units.error ?? '')
    const bypass = await tools.call('mesh_build', {
      route: 'snappy', caseDir, scaffold: true, stl: [ambiguousStl], dryRun: true,
      scaffoldOptions: { domain: { type: 'external' }, assumeUnits: 'mm', targetCells: 20000, locationInMesh: [0.075, 0.02, 0.02] },
    })
    check('tool', 'T4b', 'assumeUnits:"mm" bypasses the question and plans a mesh',
      bypass.ok === true && bypass.scaffold?.cells?.length === 3,
      JSON.stringify({ cells: bypass.scaffold?.cells, error: bypass.error, phase: bypass.phase, problems: bypass.problems, warnings: bypass.warnings?.slice(0, 1) }))
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}


// ---------------------------------------------------------------------------------------------
// tier 4 helpers: mount the workbench plugin the way DSH does, on a fake Cordis context.
// ---------------------------------------------------------------------------------------------
function findWorkbench() {
  const explicit = process.env.CONTRACT_TEST_WORKBENCH
  if (explicit) return existsSync(explicit) ? explicit : null
  const root = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(root)) return null
  for (const profile of readdirSync(root)) {
    const candidate = join(root, profile, 'node_modules', '@yakovlev-i-a', 'dsh-openfoam-workbench')
    if (existsSync(join(candidate, 'lib', 'index.js'))) return candidate
  }
  return null
}

async function mountWorkbench(pkgDir, caseRoot) {
  const registry = new Map()
  const services = new Map()
  const ctx = {
    tools: { register: (tool) => { registry.set(tool.name, tool); return { dispose: () => {} } }, get: (n) => registry.get(n) ?? null },
    get: (name) => services.get(name) ?? null,
    provide: (name, api) => { services.set(name, api); return { dispose: () => {} } },
    setInterval: () => 0,
    clearInterval: () => {},
    on: () => {},
    effect: () => {},
    systemPrompt: {
      mount: () => ({ dispose: () => {} }),
      section: () => ({ dispose: () => {} }),
    },
    skills: { register: () => ({ dispose: () => {} }) },
  }
  const mod = await import(pathToFileURL(join(pkgDir, 'lib', 'index.js')).href)
  mod.apply(ctx, { caseRoots: [caseRoot], responseLanguage: 'en' })
  return { registry, services }
}

function listFiles(dir, prefix = '') {
  const out = []
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) out.push(...listFiles(dir, rel))
    else out.push(rel)
  }
  return out.sort()
}

// ---------------------------------------------------------------------------------------------
// tier 3: OpenFOAM (T1/T2/T5/T6 with real meshes)
// ---------------------------------------------------------------------------------------------
console.log('\n== OpenFOAM tier ==')

const BASHRC_CANDIDATES = [
  process.env.CONTRACT_TEST_BASHRC,
  '/usr/lib/openfoam/openfoam2512/etc/bashrc',
  join(REPO, 'env', 'openfoam', 'com2606', 'usr', 'lib', 'openfoam', 'openfoam2606', 'etc', 'bashrc'),
].filter(Boolean)
const bashrc = BASHRC_CANDIDATES.find((p) => existsSync(p))
// Fixture: the benchmark cube when the project tree is at hand, otherwise a 10 mm box written here,
// so the tier runs in the published clone as well (CONTRACT_TEST_STL overrides both).
const benchmarkCube = join(REPO, 'benchmark', 'runs', '20261125-1805', 'stl', 'a1', 'a1-cube.stl')
const fixtureDir = mkdtempSync(join(tmpdir(), 'contract-stl-'))
const stlCube = process.env.CONTRACT_TEST_STL
  || (existsSync(benchmarkCube) ? benchmarkCube : join(fixtureDir, 'cube.stl'))
if (!existsSync(stlCube)) writeFileSync(stlCube, boxStl(-5, -5, -5, 10, 10, 10))
// snappy names surfaces after the STL stem, so the patch name follows the fixture.
const surface = basename(stlCube).replace(/\.stl$/i, '')

if (!tools || !bashrc || NO_MESH) {
  skip('openfoam', !tools ? 'tool tier unavailable' : NO_MESH ? '--no-mesh' : 'no OpenFOAM bashrc found')
} else {
  const work = mkdtempSync(join(tmpdir(), 'contract-mesh-'))
  const run = (name, args) => tools.call(name, { openfoam: bashrc, ...args })
  try {
    // T1: geometry -> mesh -> gate -> handoff, with everything a scaffold needs to take over.
    const t1 = await run('mesh_build', {
      route: 'snappy', caseDir: join(work, 't1'), scaffold: true, stl: [stlCube], np: 1,
      scaffoldOptions: {
        domainMin: [-0.004, -0.004, -0.004], domainMax: [0.014, 0.014, 0.014], cells: [18, 18, 18],
        locationInMesh: [0.006, 0.006, 0.006], minVol: 1e-12,
      },
      gate: true, profile: 'project',
    })
    // The handoff is written by mesh_check (the gate owner), so T1 runs mesh_build -> mesh_check.
    const t1Case = join(work, 't1')
    const t1Check = t1.ok ? await run('mesh_check', { caseDir: t1Case, profile: 'project', minVol: 1e-12 }) : null
    const t1Handoff = t1.ok ? readHandoff(t1Case) : null
    const t1Problems = t1Handoff ? validateHandoff(t1Handoff) : ['no handoff']
    check('openfoam', 'T1', 'T1 mesh -> gate -> handoff (scaffold-ready)',
      t1.ok === true && t1Check?.verdict === 'PASS' && t1Problems.length === 0,
      `cells ${t1Check?.cells ?? t1Check?.gate?.metrics?.cells ?? t1Check?.regions?.[0]?.metrics?.cells ?? 'n/a'}, handoff ${t1Handoff ? 'written' : 'missing'}, ${t1Problems.join('; ') || 'valid'}`)
    check('openfoam', 'T1b', 'T1 handoff carries units, patches, domain and next', Boolean(t1Handoff?.units?.scale) && Array.isArray(t1Handoff?.patches) && Boolean(t1Handoff?.domain?.bbox_m) && Array.isArray(t1Handoff?.next),
      `scale ${t1Handoff?.units?.scale}, ${t1Handoff?.patches?.length ?? 0} patches, next ${t1Handoff?.next?.length ?? 0}`)

    // T5: patch roles by retyping, and the gate numbers must not move.
    const t5 = await run('mesh_patch_types', { caseDir: t1Case, roles: { walls: [surface], symmetry: ['world'] }, recheck: true, profile: 'project', minVol: 1e-12 })
    const t5Handoff = readHandoff(t1Case)
    check('openfoam', 'T5', 'T5 roles applied and the recheck reproduces the metrics',
      t5.recheck?.verdict === 'PASS' && t5.recheck?.sameAsRecorded === true
        && (t5Handoff?.roles?.wall ?? []).includes(surface) && (t5Handoff?.roles?.symmetry ?? []).includes('world'),
      `error ${t5.error ?? 'none'}, recheck ${t5.recheck?.verdict}, sameAsRecorded ${t5.recheck?.sameAsRecorded}, wall ${JSON.stringify(t5Handoff?.roles?.wall ?? [])}, symmetry ${JSON.stringify(t5Handoff?.roles?.symmetry ?? [])}`)

    // T6: an interrupted build must not leave the case unusable — rebuild over the broken state.
    const t6Dir = join(work, 't6')
    mkdirSync(join(t6Dir, 'constant', 'polyMesh'), { recursive: true })
    writeFileSync(join(t6Dir, 'constant', 'polyMesh', 'points'), 'broken partial mesh\n')
    const t6 = await run('mesh_build', {
      route: 'snappy', caseDir: t6Dir, scaffold: true, overwrite: true, stl: [stlCube], np: 1,
      scaffoldOptions: {
        domainMin: [-0.004, -0.004, -0.004], domainMax: [0.014, 0.014, 0.014], cells: [14, 14, 14],
        locationInMesh: [0.006, 0.006, 0.006], minVol: 1e-12,
      },
      gate: true, profile: 'project',
    })
    check('openfoam', 'T6', 'T6 a broken partial mesh is rebuilt, not stuck', t6.ok === true && t6.gate?.verdict === 'PASS', `verdict ${t6.gate?.verdict ?? t6.error}`)

    // T2: bad y+ -> revise -> a second attempt that actually differs.
    const t2Case = t1Case
    const t2Plan = await run('mesh_revise', {
      caseDir: t2Case,
      feedback: { schemaVersion: 'mesh-feedback/1', requestId: 'contract', attempt: 1, category: 'yplus', severity: 'major', evidence: { metrics: { yPlusMax: 45, uRef: 10, lRef: 0.01, nu: 1.5e-5 } } },
    })
    check('openfoam', 'T2', 'T2 y+ feedback yields a layer plan with the correlation', t2Plan.ok === true && t2Plan.plan?.request?.scaffoldOptions?.nLayers > 0 && t2Plan.plan?.request?.scaffoldOptions?.layerThickness > 0,
      `nLayers ${t2Plan.plan?.request?.scaffoldOptions?.nLayers}, firstLayer ${t2Plan.plan?.firstLayer_m}`)
    const t2Apply = await run('mesh_revise', {
      caseDir: t2Case, apply: true, np: 1, profile: 'project',
      feedback: { schemaVersion: 'mesh-feedback/1', requestId: 'contract', attempt: 1, category: 'yplus', severity: 'major', evidence: { metrics: { yPlusMax: 45, uRef: 10, lRef: 0.01, nu: 1.5e-5 } } },
    })
    const t2Handoff = readHandoff(t2Case)
    check('openfoam', 'T2b', 'T2 the revision rebuilds, records history and reports changes', t2Apply.ok === true && Array.isArray(t2Apply.changes) && t2Apply.changes.length > 0 && (t2Handoff?.history ?? []).some((h) => h.event === 'revision'),
      `verdict ${t2Apply.verdict}, ${t2Apply.changes?.length ?? 0} changes, cells ${t2Apply.rebuilt?.cells}`)

    // T7: the delivery a workbench actually receives — packaged case with its own handoff.json inside.
    const deliver = await run('mesh_deliver', {
      caseDir: t1Case, name: 'contract-t1', outDir: join(work, 'deliver'), skipAnsys: true, minVol: 1e-12, gateProfile: 'project',
    })
    check('openfoam', 'T7', 'T7 delivery packages the gated case with its own handoff',
      deliver.ok === true && deliver.verdict === 'DELIVERED' && Boolean(deliver.handoff?.file),
      `verdict ${deliver.verdict}, handoff ${deliver.handoff?.file ?? deliver.handoff?.error ?? 'n/a'}, rc ${deliver.rc}`)
    const deliveredCase = deliver.ok && deliver.files?.openfoam ? dirname(deliver.files.openfoam) : null

    // -----------------------------------------------------------------------------------------
    // tier 4 (M3 seam): the workbench scaffolds the delivered case. This is the block that turns
    // "mesh + handoff" into "solvable case", and it runs on THEIR code — a red check here is the
    // earliest signal that the seam broke before anyone notices in a real project.
    // -----------------------------------------------------------------------------------------
    console.log('\n== workbench tier (M3 seam) ==')
    const wbDir = findWorkbench()
    if (!deliveredCase) {
      skip('workbench', 'no delivered case (T7 failed)')
    } else if (!wbDir) {
      skip('workbench', 'dsh-openfoam-workbench not installed — set CONTRACT_TEST_WORKBENCH=<package dir> to include this tier')
    } else {
      try {
        const wb = await mountWorkbench(wbDir, join(work, 'wb-cases'))
        const scaffold = wb.registry.get('openfoam_case_scaffold')
        if (!scaffold) {
          skip('workbench', `openfoam_case_scaffold not registered by ${wbDir}`)
        } else {
          const before = listFiles(deliveredCase)
          const answer = await scaffold.execute({ casePath: deliveredCase }, { agent: { cwd: deliveredCase } })
          const after = listFiles(deliveredCase)
          const added = after.filter((f) => !before.includes(f))
          // The delivered case already carries controlDict/fvSchemes/fvSolution (our scaffold wrote them), so the
          // criterion is the state after the call: a complete dictionary set, 0/ fields, and the BCs naming the
          // case's own patches — i.e. a solvable case without hand edits.
          const hasDictionaries = ['system/controlDict', 'system/fvSchemes', 'system/fvSolution'].every((f) => after.includes(f))
          const hasFields = ['0/U', '0/p'].every((f) => after.includes(f))
          const uText = hasFields ? readFileSync(join(deliveredCase, '0', 'U'), 'utf8') : ''
          const handoffDoc = readHandoff(deliveredCase)
          const patchNames = (handoffDoc?.patches ?? []).map((x) => x.name)
          const bcNames = [...uText.matchAll(/^ {4}([A-Za-z0-9_-]+)\n {4}\{/gm)].map((m) => m[1])
          const bcUsesPatches = patchNames.length > 0 && patchNames.every((n) => bcNames.includes(n))
          const missing = patchNames.filter((n) => !bcNames.includes(n))
          const unexpected = bcNames.filter((n) => !patchNames.includes(n))
          known('workbench', 'M3',
            'M3 the workbench scaffolds the delivered case into a solvable case',
            Boolean(answer?.ok) && hasDictionaries && hasFields && bcUsesPatches,
            `dictionaries ${hasDictionaries}, fields ${hasFields}, ${added.length} new files; BC patches [${bcNames.join(', ')}] vs mesh [${patchNames.join(', ')}]`
              + `${missing.length ? `; MISSING ${missing.join(', ')}` : ''}${unexpected.length ? `; unexpected ${unexpected.join(', ')}` : ''}`)
          // Observation, not a pass/fail: does their scaffold read handoff patch roles yet (Part B / B4)?
          const handoff = readHandoff(deliveredCase)
          const roles = (handoff?.patches ?? []).map((p) => `${p.name}:${p.role}`).join(', ')
          known('workbench', 'M3b', 'M3b the delivered case carries patch roles for the case builder',
            Boolean(roles) && Boolean(handoff?.next?.length),
            `handoff roles [${roles}]; next ${handoff?.next?.length ?? 0} suggested call(s)`)

          // M3c: a hyphenated patch name, which OpenFOAM allows and their parser truncated (0.9.22,
          // lib/of-engine.js:972, /(\w+)\s*\{([^}]*)\}/g -> "a1-cube" became "cube"). Kept as a known-gap so
          // the regression shows up here the day they fix it, without failing our own suite.
          const hyphenStl = join(work, 'a1-cube.stl')
          writeFileSync(hyphenStl, boxStl(-5, -5, -5, 10, 10, 10))
          const hyCase = join(work, 'hyphen')
          const hyBuild = await run('mesh_build', {
            route: 'snappy', caseDir: hyCase, scaffold: true, stl: [hyphenStl], np: 1,
            scaffoldOptions: { domainMin: [-0.004, -0.004, -0.004], domainMax: [0.014, 0.014, 0.014], cells: [14, 14, 14], locationInMesh: [0.006, 0.006, 0.006], minVol: 1e-12 },
            gate: false,
          })
          const hyCheck = hyBuild.ok ? await run('mesh_check', { caseDir: hyCase, profile: 'project', minVol: 1e-12 }) : null
          const hyDeliver = hyCheck?.verdict === 'PASS'
            ? await run('mesh_deliver', { caseDir: hyCase, name: 'contract-hy', outDir: join(work, 'hy-deliver'), skipAnsys: true, minVol: 1e-12, gateProfile: 'project' })
            : null
          const hyPkg = hyDeliver?.files?.openfoam ? dirname(hyDeliver.files.openfoam) : null
          if (!hyPkg) {
            skip('workbench', 'M3c needs a delivered hyphenated case (build/deliver failed)')
          } else {
            const hyAnswer = await scaffold.execute({ casePath: hyPkg }, { agent: { cwd: hyPkg } })
            const hyU = existsSync(join(hyPkg, '0', 'U')) ? readFileSync(join(hyPkg, '0', 'U'), 'utf8') : ''
            const hyNames = (readHandoff(hyPkg)?.patches ?? []).map((x) => x.name)
            const hyBc = [...hyU.matchAll(/^ {4}([A-Za-z0-9_-]+)\n {4}\{/gm)].map((m) => m[1])
            known('workbench', 'M3c', 'M3c a hyphenated patch name survives their boundary parser',
              Boolean(hyAnswer?.ok) && hyNames.every((n) => hyBc.includes(n)),
              `mesh patches [${hyNames.join(', ')}] vs 0/U patches [${hyBc.join(', ')}]`)
          }
        }
      } catch (error) {
        check('workbench', 'M3', 'M3 the workbench scaffolds the delivered case without hand edits', false, String(error.message).slice(0, 200))
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// T3: independence — no import of the workbench, and our own smoke suites pass on their own.
// ---------------------------------------------------------------------------------------------
console.log('\n== independence (T3) ==')
{
  const suspects = [
    'mesh-build/index.js', 'mesh-stl/index.js',
    'sim-core/lib/toolkit.js', 'sim-core/lib/handoff.js',
    'mesh-build/lib/caps.js', 'mesh-stl/lib/qa/index.js',
  ]
  const offenders = suspects
    .map((rel) => join(PKG, rel))
    .filter((file) => existsSync(file))
    .filter((file) => /dsh-openfoam-workbench|openfoam[_-]workbench|@yakovlev-i-a/.test(readFileSync(file, 'utf8')))
    .map((file) => file.replace(REPO + '/', '').replace(PKG + '/', ''))
  check('indep', 'T3', 'the toolkit imports nothing from the workbench', offenders.length === 0, offenders.join(',') || 'clean')
}

// ---------------------------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok)
const skipped = results.filter((r) => r.skipped)
const gaps = results.filter((r) => r.known && !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} checks passed${skipped.length ? ` (${skipped.length} tier(s) skipped)` : ''}`)
if (gaps.length) console.log(`known workbench gaps: ${gaps.map((g) => g.id).join(', ')} (set CONTRACT_TEST_REQUIRE_WORKBENCH=1 to make them failures)`)
if (failed.length) {
  console.log('failed:', failed.map((f) => `${f.tier}/${f.id} ${f.name}`).join(' | '))
  process.exit(1)
}
