#!/usr/bin/env node
/**
 * scripts/qa-parity.mjs — parity check: the in-plugin JS QA engine vs the
 * legacy python one (`tools/qa/stl_qa.py`, trimesh).
 *
 * Builds a set of small synthetic STLs (closed cube, degenerate faces, an open
 * box, non-manifold contact, triplicated ASCII facets), optionally adds the
 * benchmark fixtures of this repository, then compares both engines field by
 * field for several option sets. Exits non-zero on a real mismatch; situations
 * where trimesh's own ASCII merge differs are reported as `known` (the verdict
 * still has to agree).
 *
 * Usage:
 *   node plugins/mesh-stl/scripts/qa-parity.mjs [--project] [--fixtures a.stl,b.stl] [--strict]
 *
 * The python engine is skipped (exit 0, "SKIP") when it or trimesh is missing,
 * so the script is safe in CI without a python installation.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { qaStl } from '../lib/qa/index.js'
import { writeBinaryStl } from '../lib/qa/clean.js'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..')
const REPO_ROOT = resolve(PACKAGE_ROOT, '..', '..')
// The python reference lives in the research project (tools/qa/stl_qa.py) and,
// when this package is checked out on its own (CI, the published repository), in
// the copy shipped next to the CAD generator.
const QA_CANDIDATES = [
  join(REPO_ROOT, 'tools', 'qa', 'stl_qa.py'),
  join(REPO_ROOT, 'mesh-stl', 'generators', 'cad', 'py_qa.py'),
  join(PACKAGE_ROOT, 'generators', 'cad', 'py_qa.py'),
]
const QA_SCRIPT = process.env.MESH_STL_QA_SCRIPT || QA_CANDIDATES.find((file) => existsSync(file)) || QA_CANDIDATES[0]
const BENCH_DIR = join(REPO_ROOT, 'benchmark', 'runs', '20261125-1805')

const args = process.argv.slice(2)
const opt = (name) => args.includes(name)
const value = (name) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : null
}

// ---------------------------------------------------------------- fixtures

/** Axis-aligned box as 12 triangles with outward normals, mm. */
function boxTriangles([x0, y0, z0], [x1, y1, z1]) {
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ]
  const faces = []
  for (const [a, b, c, d] of quads) faces.push([v[a], v[b], v[c]], [v[a], v[c], v[d]])
  return faces
}

function mergeTriangles(...groups) {
  return groups.flat()
}

/** Write triangles as binary STL (via the engine's own writer). */
function writeBinaryStlFile(path, triangles) {
  const positions = []
  const faces = []
  for (const tri of triangles) {
    for (const point of tri) positions.push(...point)
    faces.push(faces.length, faces.length + 1, faces.length + 2)
  }
  writeBinaryStl(path, Float64Array.from(positions), Int32Array.from(faces))
}

/** Same triangles as ASCII STL, optionally repeated `repeat` times. */
function asciiStl(triangles, { repeat = 1 } = {}) {
  const lines = ['solid parity']
  for (let r = 0; r < repeat; r += 1) {
    for (const tri of triangles) {
      lines.push('  facet normal 0 0 0', '    outer loop')
      for (const [x, y, z] of tri) lines.push(`      vertex ${x.toFixed(6)} ${y.toFixed(6)} ${z.toFixed(6)}`)
      lines.push('    endloop', '  endfacet')
    }
  }
  lines.push('endsolid parity')
  return `${lines.join('\n')}\n`
}

function buildSynthetic(dir) {
  const cube = boxTriangles([0, 0, 0], [10, 10, 10])
  const files = []

  const plain = join(dir, 'cube-binary.stl')
  writeBinaryStlFile(plain, cube)
  files.push({ name: 'cube-binary', path: plain, cases: [
    { label: 'raw' },
    { label: 'analytic', options: { expectBodies: 1, expectVolume: 1000, expectArea: 600 } },
    { label: 'volume-2pct', options: { expectVolume: 980 } },
  ] })

  // three zero-area triangles glued to cube vertices: watertight raw? no — but cleanup fixes it
  const degenerate = [...cube]
  for (let i = 0; i < 3; i += 1) {
    const [x, y, z] = cube[i][0]
    degenerate.push([[x, y, z], [x, y, z], [x + 1, y, z]])
  }
  const degPath = join(dir, 'cube-degenerate.stl')
  writeBinaryStlFile(degPath, degenerate)
  files.push({ name: 'cube-degenerate', path: degPath, cases: [
    { label: 'raw' },
    { label: 'cleanup', options: { cleanup: true } },
  ] })

  const open = join(dir, 'open-box.stl')
  writeBinaryStlFile(open, cube.slice(0, 10))
  files.push({ name: 'open-box', path: open, cases: [{ label: 'raw' }] })

  const touching = join(dir, 'two-touching.stl')
  writeBinaryStlFile(touching, mergeTriangles(boxTriangles([0, 0, 0], [10, 10, 10]), boxTriangles([10, 0, 0], [20, 10, 10])))
  files.push({ name: 'two-touching', path: touching, cases: [
    { label: 'raw' },
    { label: 'bodies-2', options: { expectBodies: 2 } },
  ] })

  const dupPath = join(dir, 'cube-ascii-triplicated.stl')
  writeFileSync(dupPath, asciiStl(cube, { repeat: 3 }))
  files.push({ name: 'cube-ascii-triplicated', path: dupPath, cases: [{ label: 'raw' }] })

  return files
}

function benchmarkFixtures() {
  const wanted = [
    ['A1', 'stl/a1/a1-cube.stl'],
    ['A2', 'stl/a2/a2-sphere.stl'],
    ['E1raw', 'stl/e1/e1-fcc.raw.stl'],
    ['C4raw', 'stl/c4/c4-junction.raw.stl'],
    ['fluid', 'stl/b1/fluid.stl'],
    ['patches', 'stl/b1/fluid_patches.stl'],
  ]
  const files = []
  for (const [name, rel] of wanted) {
    const path = join(BENCH_DIR, rel)
    if (existsSync(path)) files.push({ name, path, cases: [{ label: 'raw' }] })
  }
  return files
}

// ---------------------------------------------------------------- engines

function pythonEngine(file, options) {
  const jsonFile = join(tmpdir(), `qa-parity-${process.pid}-${Math.random().toString(36).slice(2)}.json`)
  const cli = [QA_SCRIPT, '--stl', file, '--json', jsonFile, '--quiet']
  const cleanOut = options.cleanup ? `${file}.clean.parity.stl` : null
  if (cleanOut) cli.push('--clean-out', cleanOut)
  if (options.expectVolume != null) cli.push('--expect-volume', String(options.expectVolume))
  if (options.expectArea != null) cli.push('--expect-area', String(options.expectArea))
  if (options.expectBodies != null) cli.push('--expect-bodies', String(options.expectBodies))
  const python = process.env.MESH_STL_PYTHON
    || (existsSync(join(REPO_ROOT, '.venv', 'bin', 'python')) ? join(REPO_ROOT, '.venv', 'bin', 'python') : 'python3')
  // exit 1 means "QA verdict FAIL" and still writes the JSON; 2 is an input error
  try {
    execFileSync(python, cli, { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (error) {
    if (error.status !== 1) throw error
  }
  const report = JSON.parse(readFileSync(jsonFile, 'utf8'))
  return {
    verdict: report.verdict,
    problems: report.qa_problems ?? [],
    warnings: report.warnings ?? [],
    triangles: report.cleaned?.triangles ?? report.triangles,
    bodies: report.cleaned?.bodies ?? report.bodies,
    watertight: report.cleaned?.is_watertight ?? report.is_watertight,
    windingConsistent: report.cleaned?.is_winding_consistent ?? report.is_winding_consistent,
    volumeMm3: report.cleaned?.volume ?? report.volume,
    areaMm2: report.cleaned?.area ?? report.area,
    degenerateFaces: report.degenerate_faces,
    duplicateFaceGroups: report.duplicate_face_groups,
    nonManifoldEdges: report.non_manifold_edges,
    verticesMerged: report.vertices_merged,
    eulerNumber: report.euler_number,
    clean: report.clean ?? null,
  }
}

function jsEngine(file, options) {
  const cleanOut = options.cleanup ? `${file}.clean.js.stl` : undefined
  const report = qaStl(file, {
    cleanOut,
    expectVolume: options.expectVolume,
    expectArea: options.expectArea,
    expectBodies: options.expectBodies,
  })
  return {
    verdict: report.verdict,
    problems: report.problems ?? [],
    warnings: report.warnings ?? [],
    triangles: report.cleaned?.triangles ?? report.triangles,
    bodies: report.cleaned?.bodies ?? report.bodies,
    watertight: report.cleaned?.is_watertight ?? report.is_watertight,
    windingConsistent: report.cleaned?.is_winding_consistent ?? report.is_winding_consistent,
    volumeMm3: report.cleaned?.volume ?? report.volume,
    areaMm2: report.cleaned?.area ?? report.area,
    degenerateFaces: report.degenerate_faces,
    duplicateFaceGroups: report.duplicate_face_groups,
    nonManifoldEdges: report.non_manifold_edges,
    verticesMerged: report.vertices_merged,
    eulerNumber: report.euler_number,
    clean: report.clean ?? null,
  }
}

// ---------------------------------------------------------------- compare

const STRICT_FIELDS = ['verdict', 'triangles', 'bodies', 'watertight', 'windingConsistent', 'degenerateFaces', 'duplicateFaceGroups']
const REFERENCE_FIELDS = ['verticesMerged', 'nonManifoldEdges', 'eulerNumber']
const REL_TOL = 1e-6

const close = (a, b) => {
  if (a === null || b === null) return a === b
  const scale = Math.max(Math.abs(a), Math.abs(b), 1e-12)
  return Math.abs(a - b) / scale <= REL_TOL
}

const sameList = (a, b) => JSON.stringify(a) === JSON.stringify(b)
// numbers inside verdict strings depend on topology that trimesh may merge differently
const maskDigits = (list) => list.map((line) => line.replace(/\d+(?:\.\d+)?/g, '#'))

function compare(js, py, { strict }) {
  const differences = []
  const known = []
  for (const field of STRICT_FIELDS) {
    if (!Object.is(js[field], py[field])) differences.push(`${field}: js=${JSON.stringify(js[field])} python=${JSON.stringify(py[field])}`)
  }
  if (!close(js.volumeMm3, py.volumeMm3)) differences.push(`volumeMm3: js=${js.volumeMm3} python=${py.volumeMm3}`)
  if (!close(js.areaMm2, py.areaMm2)) differences.push(`areaMm2: js=${js.areaMm2} python=${py.areaMm2}`)
  if (!sameList(js.problems, py.problems)) {
    const line = `problems:\n    js=${JSON.stringify(js.problems)}\n    python=${JSON.stringify(py.problems)}`
    if (sameList(maskDigits(js.problems), maskDigits(py.problems))) known.push(line)
    else differences.push(line)
  }
  if (!sameList(js.warnings, py.warnings)) {
    const line = `warnings:\n    js=${JSON.stringify(js.warnings)}\n    python=${JSON.stringify(py.warnings)}`
    if (sameList(maskDigits(js.warnings), maskDigits(py.warnings))) known.push(line)
    else differences.push(line)
  }
  for (const field of REFERENCE_FIELDS) {
    if (!Object.is(js[field], py[field])) {
      const line = `${field}: js=${JSON.stringify(js[field])} python=${JSON.stringify(py[field])}`
      ;(strict ? differences : known).push(line)
    }
  }
  if (js.clean || py.clean) {
    for (const field of ['triangles_after', 'triangles_before', 'is_watertight', 'bodies']) {
      if (!Object.is(js.clean?.[field], py.clean?.[field])) {
        differences.push(`clean.${field}: js=${JSON.stringify(js.clean?.[field])} python=${JSON.stringify(py.clean?.[field])}`)
      }
    }
  }
  return { differences, known }
}

// ---------------------------------------------------------------- main

const pyAvailable = (() => {
  if (!existsSync(QA_SCRIPT)) return { ok: false, why: `no ${QA_SCRIPT}` }
  const python = process.env.MESH_STL_PYTHON
    || (existsSync(join(REPO_ROOT, '.venv', 'bin', 'python')) ? join(REPO_ROOT, '.venv', 'bin', 'python') : 'python3')
  try {
    execFileSync(python, ['-c', 'import trimesh'], { stdio: 'ignore' })
    return { ok: true }
  } catch {
    return { ok: false, why: `${python} cannot import trimesh` }
  }
})()

if (!pyAvailable.ok) {
  console.log(`SKIP qa parity: ${pyAvailable.why} — the JS engine has no python counterpart to compare with`)
  process.exit(0)
}

const workDir = mkdtempSync(join(tmpdir(), 'qa-parity-'))
const fixtures = buildSynthetic(workDir)
const extra = value('--fixtures')
if (extra) {
  for (const [i, path] of extra.split(',').entries()) {
    fixtures.push({ name: `extra-${i + 1}`, path: resolve(path), cases: [{ label: 'raw' }] })
  }
}
if (opt('--project')) fixtures.push(...benchmarkFixtures())

let failures = 0
let checks = 0
const knownNotes = []
for (const fixture of fixtures) {
  if (!existsSync(fixture.path)) {
    console.log(`SKIP ${fixture.name}: ${fixture.path} not found`)
    continue
  }
  for (const testCase of fixture.cases) {
    checks += 1
    const js = jsEngine(fixture.path, testCase.options ?? {})
    const py = pythonEngine(fixture.path, testCase.options ?? {})
    const { differences, known } = compare(js, py, { strict: opt('--strict') })
    const label = `${fixture.name} [${testCase.label}]`
    if (differences.length === 0) {
      console.log(`ok   ${label} — verdict ${js.verdict}`)
    } else {
      failures += 1
      console.log(`FAIL ${label}`)
      for (const line of differences) console.log(`     ${line}`)
    }
    if (known.length > 0) knownNotes.push(`${label}: ${known.join('; ')}`)
  }
}

if (knownNotes.length > 0) {
  console.log('\nknown divergence (topology-sensitive fields; trimesh merges ASCII facets by its own normals):')
  for (const note of knownNotes) console.log(`  - ${note}`)
}
console.log(`\n${checks - failures}/${checks} checks match the python engine`)
process.exit(failures === 0 ? 0 : 1)
