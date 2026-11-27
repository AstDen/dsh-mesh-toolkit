#!/usr/bin/env node
/**
 * scaffold-advanced.mjs — write a snappy case with the TW-02 advanced options and optionally run it.
 *
 * The DSH host caches ESM modules, so `mesh_build` inside a live session keeps the old code until the
 * host restarts. This CLI is the verification path: it imports the same lib code from disk.
 *
 *   node plugins/mesh-build/scripts/scaffold-advanced.mjs \
 *     --stl stl/cad_channel_cylinders_v1.stl --out experiments/exp-025_tutorial-2606/cases/tw02-zones \
 *     --domain -1,-1,-1:13,7,7 --cell 1.0 --location 0.5,3,3 --build com2606 \
 *     --advanced '{"zones":{"cad_channel_cylinders_v1":{"cellZone":"fluid","faceZone":"fluidFaces","insidePoints":[[6,3,3]]}}}' \
 *     --run
 *
 * Lengths in the CLI are MILLIMETRES (project convention for STL); the case is in metres.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { normalizeConfig } from '../lib/common.js'
import { writeSnappyCase } from '../lib/scaffold.js'
import { withFoam } from '../../sim-core/lib/foam.js'
import { gateCase } from '../lib/gate.js'
import { q, runBash } from '../../sim-core/lib/process.js'

function parseArgs(argv) {
  const out = { run: false }
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i]
    if (key === '--run') { out.run = true; continue }
    if (key === '--dry-run') { out.dryRun = true; continue }
    const next = argv[i + 1]
    if (!key.startsWith('--') || next === undefined) throw new Error(`bad argument: ${key}`)
    out[key.slice(2)] = next
    i += 1
  }
  return out
}

const mm = (text) => String(text).split(',').map((v) => Number(v) / 1000)
const triple = (text) => String(text).split(',').map(Number)

const args = parseArgs(process.argv.slice(2))
if (!args.stl || !args.out) {
  console.error('usage: scaffold-advanced.mjs --stl <file> --out <dir> --domain <minMM>:<maxMM> --cell <mm> --location <xMM,yMM,zMM> [--advanced <json>] [--build com2606] [--run]')
  process.exit(2)
}
const base = normalizeConfig({ projectRoot: process.cwd() })
const config = args.build ? withFoam(base, args.build) : base
const outDir = resolve(config.projectRoot, args.out)
mkdirSync(outDir, { recursive: true })

const [minText, maxText] = String(args.domain).split(':')
const advanced = args.advanced ? JSON.parse(args.advanced) : null
// The advanced JSON is written the way the CLI user thinks (millimetres, like the STL); the library
// contract is metres, so point lists are converted here and nowhere else.
const mmPoints = (list) => (Array.isArray(list) ? list.map((pt) => pt.map((v) => Number(v) / 1000)) : list)
if (advanced?.zones) {
  for (const spec of Object.values(advanced.zones)) spec.insidePoints = mmPoints(spec.insidePoints)
}
if (advanced?.leak?.outsidePoints) advanced.leak.outsidePoints = mmPoints(advanced.leak.outsidePoints)
const stlName = args.stl.split('/').pop().replace(/\.stl$/i, '')
const scaffoldOptions = {
  domainMin: mm(minText),
  domainMax: mm(maxText),
  cellSize: Number(args.cell) / 1000,
  locationInMesh: mm(args.location),
  refinementLevels: { [stlName]: Number(args.level ?? 1) },
  advanced,
}
if (args.layers) {
  scaffoldOptions.layerSurfaces = [stlName]
  scaffoldOptions.nLayers = Number(args.layers)
}
const written = writeSnappyCase(config, outDir, { stl: [args.stl], ...scaffoldOptions })
console.log(JSON.stringify({
  step: 'scaffold', caseDir: written.caseDirDisplay, cells: written.cells,
  advanced: written.advanced, warnings: written.warnings,
}, null, 2))

if (!args.run || args.dryRun) process.exit(0)

const steps = [
  ['blockMesh', 'blockMesh'],
  ['surfaceFeatureExtract', 'surfaceFeatureExtract'],
  ['snappyHexMesh', 'snappyHexMesh -overwrite'],
  ['checkMesh', 'checkMesh'],
]
const runSteps = []
for (const [name, command] of steps) {
  const log = join(outDir, 'logs', `${name}.log`)
  mkdirSync(join(outDir, 'logs'), { recursive: true })
  const result = runBash(`${command} > ${q(log)} 2>&1`, {
    cwd: outDir,
    openfoamBashrc: config.openfoamBashrc,
    timeoutMs: Number(args.timeout ?? 1800000),
    maxBuffer: 64 * 1024 * 1024,
  })
  runSteps.push({ name, command, exitCode: result.code, durationSec: Number((result.durationMs / 1000).toFixed(1)), log: log.replace(`${config.projectRoot}/`, '') })
  console.log(JSON.stringify({ step: name, exitCode: result.code, durationSec: runSteps.at(-1).durationSec }))
  if (result.code !== 0) {
    console.error(`step ${name} failed; see ${log}`)
    process.exit(1)
  }
}
const gate = gateCase(config, outDir, { profile: args.profile ?? 'gate', writeFields: '(nonOrthoAngle)' })
console.log(JSON.stringify({ step: 'gate', verdict: gate.verdict, metrics: gate.results?.[0]?.metrics, writtenFields: gate.results?.[0]?.writtenFields, steps: runSteps }, null, 2))
