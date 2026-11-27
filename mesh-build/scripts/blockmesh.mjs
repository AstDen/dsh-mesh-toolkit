#!/usr/bin/env node
/**
 * blockmesh.mjs — the TW-03 oracle: expand a blockMeshDict, parse it into a spec, regenerate the
 * dictionary from the spec, mesh both and compare the numbers.
 *
 *   node plugins/mesh-build/scripts/blockmesh.mjs roundtrip <tutorial case> [--out DIR] [--build com2606]
 *   node plugins/mesh-build/scripts/blockmesh.mjs expand <case> [--json]
 *   node plugins/mesh-build/scripts/blockmesh.mjs build <spec.json> --out DIR [--run]
 *
 * DSH caches ES modules, so the plugin tools in a live session keep the old code; this CLI imports
 * lib/blockmesh.js from disk and is how the generator is verified.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { normalizeConfig } from '../lib/common.js'
import { probeTutorials } from '../lib/tutorial.js'
import { blockMeshFingerprint, blockMeshSpecDict, fingerprintsEqual, parseBlockMeshDict } from '../lib/blockmesh.js'
import { withFoam } from '../../sim-core/lib/foam.js'
import { parseCheckMesh } from '../../sim-core/lib/checkmesh.js'
import { q, runBash } from '../../sim-core/lib/process.js'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { out._.push(arg); continue }
    const key = arg.replace(/^--/, '')
    if (key === 'json' || key === 'run') { out[key] = true; continue }
    out[key] = argv[i + 1]
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0] ?? 'roundtrip'
const base = normalizeConfig({ projectRoot: process.cwd() })
const config = args.build ? withFoam(base, args.build) : base
const foam = (command_, cwd) => runBash(command_, {
  cwd,
  openfoamBashrc: config.openfoamBashrc,
  timeoutMs: Number(args.timeout ?? 600000),
  maxBuffer: 64 * 1024 * 1024,
})

/** `foamDictionary -expand` resolves the macros blockMesh would resolve itself. */
function expandDict(caseDir, outFile) {
  const result = foam(`foamDictionary -expand ${q(join(caseDir, 'system', 'blockMeshDict'))}`, caseDir)
  if (result.code !== 0) throw new Error(`foamDictionary -expand failed: ${result.stderr.slice(-600)}`)
  writeFileSync(outFile, result.stdout)
  return outFile
}

function meshNumbers(caseDir) {
  const mesh = foam('blockMesh', caseDir)
  if (mesh.code !== 0) return { ok: false, stage: 'blockMesh', stderr: mesh.stderr.slice(-800), stdout: mesh.stdout.slice(-400) }
  const check = foam('checkMesh', caseDir)
  const stats = parseCheckMesh(`${check.stdout}\n${check.stderr}`)
  return {
    ok: check.code === 0,
    stage: 'checkMesh',
    cells: stats.cells,
    points: stats.points,
    faces: stats.faces,
    maxNonOrtho: stats.maxNonOrtho,
    patches: readPatches(caseDir),
  }
}

function readPatches(caseDir) {
  const file = join(caseDir, 'constant', 'polyMesh', 'boundary')
  if (!existsSync(file)) return []
  const text = readFileSync(file, 'utf8')
  const patches = []
  for (const match of text.matchAll(/\n {4}(\w+)\n {4}\{\n {8}type\s+(\w+);\n {8}nFaces\s+(\d+);/g)) {
    patches.push({ name: match[1], type: match[2], nFaces: Number(match[3]) })
  }
  return patches.sort((a, b) => a.name.localeCompare(b.name))
}

if (command === 'expand') {
  const caseDir = args._[1]
  if (!caseDir) throw new Error('expand needs a case directory')
  const out = args.out ?? join(config.projectRoot, '.cache', 'blockmesh-expand', `${basename(resolve(caseDir))}.dict`)
  mkdirSync(resolve(out, '..'), { recursive: true })
  expandDict(resolve(config.projectRoot, caseDir), out)
  const spec = parseBlockMeshDict(readFileSync(out, 'utf8'))
  console.log(JSON.stringify({ expanded: out, spec, fingerprint: blockMeshFingerprint(spec) }, null, 2))
} else if (command === 'build') {
  const specFile = args._[1]
  if (!specFile) throw new Error('build needs a spec JSON file')
  const spec = JSON.parse(readFileSync(specFile, 'utf8'))
  const outDir = resolve(config.projectRoot, args.out ?? '.cache/blockmesh-build')
  mkdirSync(join(outDir, 'system'), { recursive: true })
  writeFileSync(join(outDir, 'system', 'blockMeshDict'), blockMeshSpecDict(spec))
  console.log(JSON.stringify({ caseDir: outDir, fingerprint: blockMeshFingerprint(spec) }, null, 2))
  if (args.run) console.log(JSON.stringify(meshNumbers(outDir), null, 2))
} else if (command === 'roundtrip') {
  const sourceDir = args._[1]
  if (!sourceDir) throw new Error('roundtrip needs a tutorial case directory')
  // Accept both a filesystem path and a tutorial id (`blockMesh/sphere7`), resolved against
  // the tutorials/mesh root of the selected build — the id is what the docs and the plan use.
  const direct = resolve(config.projectRoot, sourceDir)
  const source = existsSync(direct) ? direct : resolve(probeTutorials(config).root, sourceDir)
  if (!existsSync(source)) throw new Error(`roundtrip: no such case: ${sourceDir} (tried ${direct} and ${source})`)
  const name = basename(source)
  const work = resolve(config.projectRoot, args.out ?? '.cache/blockmesh-roundtrip')
  const original = join(work, `${name}-original`)
  const regenerated = join(work, `${name}-regenerated`)
  for (const dir of [original, regenerated]) rmSync(dir, { recursive: true, force: true })
  cpSync(source, original, { recursive: true })
  cpSync(source, regenerated, { recursive: true })
  // The regenerated case keeps system/ and 0/ from the tutorial but must not inherit the original mesh.
  rmSync(join(regenerated, 'constant', 'polyMesh'), { recursive: true, force: true })
  const expanded = expandDict(original, join(work, `${name}.expanded.dict`))
  const spec = parseBlockMeshDict(readFileSync(expanded, 'utf8'))
  writeFileSync(join(regenerated, 'system', 'blockMeshDict'), blockMeshSpecDict(spec))
  const roundTrip = fingerprintsEqual(blockMeshFingerprint(spec), blockMeshFingerprint(parseBlockMeshDict(readFileSync(join(regenerated, 'system', 'blockMeshDict'), 'utf8'))))
  const before = meshNumbers(original)
  const after = meshNumbers(regenerated)
  const same = (a, b) => a === b
  const patchesSame = JSON.stringify(before.patches) === JSON.stringify(after.patches)
  const verdict = before.ok && after.ok && same(before.cells, after.cells) && same(before.points, after.points) && same(before.faces, after.faces) && patchesSame
  console.log(JSON.stringify({
    case: name,
    source: sourceDir,
    expanded,
    specFingerprint: {
      vertices: spec.vertices.length, blocks: spec.blocks.length, edges: spec.edges.length,
      cells: spec.blocks.reduce((sum, block) => sum + block.cells[0] * block.cells[1] * block.cells[2], 0),
      patches: Object.keys(spec.boundary),
    },
    dictionaryRoundTripEqual: roundTrip,
    original: before,
    regenerated: after,
    verdict: verdict ? 'PASS' : 'FAIL',
    differences: [
      !same(before.cells, after.cells) ? `cells ${before.cells} -> ${after.cells}` : null,
      !same(before.points, after.points) ? `points ${before.points} -> ${after.points}` : null,
      !same(before.faces, after.faces) ? `faces ${before.faces} -> ${after.faces}` : null,
      !patchesSame ? 'patches differ' : null,
    ].filter(Boolean),
  }, null, 2))
  process.exit(verdict ? 0 : 1)
} else {
  console.error(`unknown command "${command}" (expand|build|roundtrip)`)
  process.exit(2)
}
