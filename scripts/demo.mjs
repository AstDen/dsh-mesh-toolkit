#!/usr/bin/env node
/**
 * Self-test on a cube: generate geometry, mesh it, gate it, deliver it — through the real tools.
 *
 * This is the one command that answers "does this installation work?" without an agent in the loop.
 * It uses a closed 10 mm box with a 4 mm sphere removed (a pore-scale playground), the snappy route,
 * the project gate profile and full delivery to OpenFOAM + Ansys/Fluent.
 *
 *   node scripts/demo.mjs                 # full run, artefacts under ./.mesh-demo
 *   node scripts/demo.mjs --out /tmp/x    # choose the working directory
 *   node scripts/demo.mjs --no-ansys      # skip the .msh part (faster)
 *   node scripts/demo.mjs --quick         # 40k background cells instead of 120k
 *
 * Exit code 0 means every step passed its own verdict (QA PASS, gate PASS, DELIVERED).
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = existsSync(join(REPO, 'plugins', 'sim-core')) ? join(REPO, 'plugins') : REPO
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const option = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at >= 0 && argv[at + 1] ? argv[at + 1] : fallback
}

const OUT = resolve(option('out', join(process.cwd(), '.mesh-demo')))
const ANSYS = !flag('no-ansys')
const TARGET_CELLS = flag('quick') ? 40000 : 120000
// Absolute minVol (m³), not a fraction: a 10 mm case with ~0.2 mm cells gives pyramids around 1e-13,
// and the gate's advisory suggests a value when the one you passed is stricter than the mesh needs.
const MIN_VOL = 1e-14

const started = Date.now()
const stepTimes = []
function step(label) {
  stepTimes.push({ label, at: (Date.now() - started) / 1000 })
  console.log(`\n[${((Date.now() - started) / 1000).toFixed(1)}s] ${label}`)
}

/** Fake Cordis context: just enough for the two bundles to register their tools. */
function makeContext() {
  const registry = new Map()
  const services = new Map()
  const ctx = {
    tools: { register: (tool) => { registry.set(tool.name, tool); return { dispose: () => registry.delete(tool.name) } }, get: (name) => registry.get(name) ?? null },
    get(name) { return services.get(name) ?? null },
    provide(name, api) { services.set(name, api); return { dispose: () => services.delete(name) } },
    setInterval: () => 0,
    clearInterval: () => {},
    on: () => {},
    effect: () => {},
    systemPrompt: { mount: () => ({ dispose: () => {} }), section: () => ({ dispose: () => {} }) },
    skills: { register: () => ({ dispose: () => {} }) },
  }
  return { ctx, registry }
}

const { ctx, registry } = makeContext()
for (const pkg of ['mesh-stl', 'mesh-build']) {
  const mod = await import(pathToFileURL(join(PKG, pkg, 'index.js')).href)
  mod.apply(ctx, {})
}
const call = (name, args) => {
  const tool = registry.get(name)
  if (!tool) throw new Error(`tool ${name} is not registered (${registry.size} tools loaded)`)
  return tool.execute(args, { agent: { cwd: OUT } })
}
const fail = (message) => {
  console.error(`\nDEMO FAILED: ${message}`)
  process.exit(1)
}

mkdirSync(OUT, { recursive: true })
console.log(`mesh-toolkit demo — ${registry.size} tools, working directory ${OUT}`)

// 1. geometry: a 10 mm box with a 4 mm sphere removed, written as one STL (millimetres, the project convention)
step('1/5 geometry — box 10 mm with a 3.5 mm-radius sphere removed')
const stlPath = join(OUT, 'geo', 'pore-demo.stl')
const geometry = await call('stl_generate', {
  family: 'primitive',
  name: 'pore-demo',
  outDir: join(OUT, 'geo'),
  params: {
    parts: [
      { shape: 'box', size_mm: [10, 10, 10] },
      { shape: 'sphere', radius_mm: 3.5, segments: 48, rings: 24 },
    ],
  },
})
const generated = geometry.files?.find((file) => file.role === 'solid')
if (geometry.failure || !generated) fail(`stl_generate: ${JSON.stringify(geometry.failure ?? geometry.missingOutputs).slice(0, 400)}`)
const stlQa = generated.qa ?? {}
console.log(`   ${generated.display} · ${stlQa.triangles} triangles · ${stlQa.bodies} closed shells · bbox ${JSON.stringify(stlQa.bboxMm)} mm`)

// 2. STL contract QA (watertight, winding, units)
step('2/5 STL contract')
const qa = await call('stl_check', { stl: generated.path, cleanup: true })
const qaVerdict = qa.verdict ?? qa.qa?.verdict
if (!qaVerdict || !/PASS/i.test(String(qaVerdict))) fail(`stl_check: ${JSON.stringify(qa).slice(0, 600)}`)
console.log(`   ${qaVerdict} · watertight ${qa.watertight ?? qa.qa?.watertight} · ${qa.triangles ?? qa.qa?.triangles} triangles`)

// 3. mesh: snappy scaffold from the STL, metres in the case, mm in the STL
step('3/5 mesh — snappyHexMesh')
const caseDir = join(OUT, 'case')
const surface = 'pore-demo'
const built = await call('mesh_build', {
  route: 'snappy',
  stl: [generated.path],
  caseDir,
  scaffold: true,
  overwrite: true,
  minVol: MIN_VOL,
  scaffoldOptions: {
    // external flow around the body: the background boundary stays as the `world` patch, which an
    // internal domain of a closed body legitimately drops (the STL surface becomes the boundary)
    domain: { type: 'external' },
    targetCells: TARGET_CELLS,
    refinementLevels: { [surface]: [1, 2] },
    // metres: the STL is in mm (10 mm box) but the case is built in metres; this point sits upstream of the body
    locationInMesh: [-0.02, 0, 0],
  },
})
if (!built.ok) fail(`mesh_build: ${JSON.stringify(built).slice(0, 800)}`)
const builtGate = built.gate ?? {}
console.log(`   background cells ${built.scaffold?.cells ?? built.written?.scaffold?.cells ?? '?'} · gate ${builtGate.verdict ?? 'n/a'} (${builtGate.profile ?? 'project'}) · ${built.durationMs ? (built.durationMs / 1000).toFixed(1) + 's' : ''}`)

// 4. gate + passport + handoff, with an explicit absolute minVol
step('4/5 quality gate — checkMesh -meshQuality + passport')
const checked = await call('mesh_check', { caseDir, minVol: MIN_VOL, profile: 'project' })
if (!checked.verdict || !String(checked.verdict).toUpperCase().includes('PASS')) {
  fail(`mesh_check: ${JSON.stringify(checked).slice(0, 800)}`)
}
const metrics = checked.metrics ?? checked.results?.[0]?.metrics ?? {}
console.log(`   cells ${metrics.cells} · maxNonOrtho ${metrics.maxNonOrtho}° · maxSkewness ${metrics.maxSkewness} · minVolume ${metrics.minVolume} m³`)
console.log(`   ${checked.verdict} · passport ${checked.passport?.status ?? 'written'} · handoff ${checked.handoff ? (checked.handoff.patches?.length ? checked.handoff.patches.length + ' patches' : 'written') : 'n/a'}`)

// 5. delivery: OpenFOAM case + tarball, and an Ansys/Fluent .msh + journal
step(`5/5 delivery — ${ANSYS ? 'OpenFOAM + Ansys' : 'OpenFOAM only'}`)
const delivered = await call('mesh_deliver', {
  caseDir,
  name: 'demo',
  outDir: join(OUT, 'deliver'),
  minVol: MIN_VOL,
  gateProfile: 'project',
  skipAnsys: !ANSYS,
})
if (!delivered.ok || !/DELIVER/i.test(String(delivered.verdict ?? ''))) {
  fail(`mesh_deliver: ${JSON.stringify(delivered).slice(0, 800)}`)
}
console.log(`   ${delivered.verdict}`)
for (const [key, value] of Object.entries(delivered.files ?? {})) console.log(`   ${key}: ${value}`)

const seconds = ((Date.now() - started) / 1000).toFixed(1)
const summary = {
  ok: true,
  seconds: Number(seconds),
  tools: registry.size,
  stl: { file: generated.path, triangles: stlQa.triangles, bodies: stlQa.bodies, verdict: qaVerdict },
  mesh: { caseDir, cells: metrics.cells, maxNonOrtho: metrics.maxNonOrtho, maxSkewness: metrics.maxSkewness, minVolume: metrics.minVolume },
  gate: { verdict: checked.verdict, minVol: MIN_VOL, profile: 'project' },
  delivery: { verdict: delivered.verdict, files: delivered.files },
  steps: stepTimes,
}
console.log(`\n${JSON.stringify(summary, null, 2)}`)
console.log(`\nDEMO OK in ${seconds}s — open ${delivered.files?.openfoam ?? join(OUT, 'deliver')} in ParaView`)
