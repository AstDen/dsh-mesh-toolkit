#!/usr/bin/env node
/**
 * mesh-build/scripts/tutorial.mjs — drive lib/tutorial.js without DSH.
 *
 * DSH caches ES modules, so a tool call in a live session keeps running the code loaded at
 * start. This CLI imports the module fresh from disk, which is how the tutorial runner is
 * verified during development.
 *
 * Usage:
 *   node plugins/mesh-build/scripts/tutorial.mjs list [--build com2606] [--json] [--no-parse]
 *   node plugins/mesh-build/scripts/tutorial.mjs run <case> [--build com2606] [--out DIR]
 *        [--np N] [--steps mesh-only|all|blockMesh,snappyHexMesh] [--force] [--timeout MS]
 *        [--keep-going] [--allow-manual] [--profile gate|project] [--min-vol V]
 *        [--min-vol V] [--profile NAME] [--dry-run]
 *   node plugins/mesh-build/scripts/tutorial.mjs compare <baseline.json> <current.json>
 *        [--cells-tol 0.05] [--non-ortho-tol 2]
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizeConfig } from '../lib/common.js'
import { compareTutorialManifest, listTutorials, runTutorial } from '../lib/tutorial.js'
import { withFoam } from '../../sim-core/lib/foam.js'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) { out._.push(arg); continue }
    const key = arg.replace(/^--/, '')
    if (['json', 'force', 'dry-run', 'no-parse', 'keep-going', 'allow-manual'].includes(key)) { out[key] = true; continue }
    out[key] = argv[i + 1]
    i += 1
  }
  return out
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0] ?? 'list'
const projectRoot = process.cwd()
const base = normalizeConfig({ projectRoot })
const config = args.build ? withFoam(base, args.build) : base

if (command === 'list') {
  const report = listTutorials(config, { parse: !args['no-parse'] })
  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } else if (!report.ok) {
    process.stdout.write(`list failed: ${report.error}\n`)
    process.exitCode = 1
  } else {
    const lines = [`root: ${report.root}`, `build: ${report.version} (${report.bashrc})`,
      `cases: ${report.counts.cases}  controlDicts: ${report.counts.controlDicts}  runnable: ${report.counts.runnable}  manual: ${report.counts.manual}`,
      'families: ' + Object.entries(report.families).map(([k, v]) => `${k}=${v}`).join(' '), '']
    for (const entry of report.cases) {
      const flags = [entry.runnable ? 'ok' : 'manual', entry.missingUtils.length ? `missing:${entry.missingUtils.join(',')}` : '', `${entry.stepCount} steps`]
      lines.push(`${entry.id.padEnd(52)} ${flags.filter(Boolean).join('  ')}`)
      for (const m of entry.manual) lines.push(`    line ${m.line}: ${m.reason} — ${m.text}`)
    }
    process.stdout.write(`${lines.join('\n')}\n`)
  }
} else if (command === 'run') {
  const caseId = args._[1]
  if (!caseId) {
    process.stdout.write('usage: tutorial.mjs run <case> [--out DIR] [--np N] [--steps mesh-only]\n')
    process.exitCode = 2
  } else {
    const steps = args.steps === undefined
      ? 'mesh-only'
      : (args.steps === 'all' || args.steps === 'mesh-only' ? args.steps : String(args.steps).split(','))
    const result = await runTutorial(config, {
      case: caseId,
      out: args.out ? resolve(projectRoot, args.out) : undefined,
      np: args.np ? Number(args.np) : undefined,
      steps,
      force: Boolean(args.force),
      dryRun: Boolean(args['dry-run']),
      timeoutMs: args.timeout ? Number(args.timeout) : undefined,
      minVol: args['min-vol'] ? Number(args['min-vol']) : undefined,
      profile: args.profile,
      allowManual: Boolean(args['allow-manual']),
      keepGoing: Boolean(args['keep-going']),
    })
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (result.ok === false) process.exitCode = 1
  }
} else if (command === 'compare') {
  const [baselineFile, currentFile] = args._.slice(1)
  if (!baselineFile || !currentFile) {
    process.stdout.write('usage: tutorial.mjs compare <baseline.json> <current.json>\n')
    process.exitCode = 2
  } else {
    const result = compareTutorialManifest(
      JSON.parse(readFileSync(resolve(projectRoot, baselineFile), 'utf8')),
      JSON.parse(readFileSync(resolve(projectRoot, currentFile), 'utf8')),
      {
        cellsTolerance: args['cells-tol'] ? Number(args['cells-tol']) : 0.05,
        nonOrthoTolerance: args['non-ortho-tol'] ? Number(args['non-ortho-tol']) : 2,
      },
    )
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
  }
} else {
  process.stdout.write(`unknown command "${command}" (list | run | compare)\n`)
  process.exitCode = 2
}
