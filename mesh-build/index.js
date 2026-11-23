/**
 * mesh-build — DSH plugin: volume meshing and quality gate for the pore-scale project.
 *
 * Tools: mesh_hints, mesh_build, mesh_check.
 * Routes (snappy / cfmesh / gmsh / check) live in data/engine.json, knowledge cards in
 * data/hints/*.json, so the toolset can be grown or trimmed by editing data, not code.
 * @module mesh-build
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  PKG_VERSION, displayPath, executionCwd, expandStlInputs, jsonSafe, normalizeConfig, resolveProjectPath,
  tail, unconfiguredPayload,
} from './lib/common.js'
import { gateCase } from './lib/gate.js'
import { catalogHints, hintsOverview, loadHints, searchHints } from './lib/hints.js'
import {
  catalogRoutes, loadEngine, makeContext, planRoute, preflight, runRoute,
} from './lib/routes.js'
import { isEmptyDir, installStl, writeSnappyCase } from './lib/scaffold.js'
import { SKILL } from './lib/skill.js'

export const name = 'mesh-build'
export const version = PKG_VERSION
export const inject = ['tools', 'skills']

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
const jsonOutput = { schema: { type: 'json' }, render: (_args, value) => text(value) }

const SCAFFOLD_KEYS = [
  'domainMin', 'domainMax', 'cells', 'cellSize', 'locationInMesh', 'locationsInMesh',
  'refinementLevels', 'defaultLevel', 'layerSurfaces', 'nLayers', 'layerThickness',
  'minThickness', 'symmetryDomain', 'minVol', 'maxNonOrtho', 'resolveFeatureAngle',
]

/** Last "Added N out of M cells (P%)" line from a snappy log. */
function parseSnappyLayers(logText) {
  const regex = /Added (\d+) out of (\d+) cells \(([\d.]+)%\)/g
  let match = null
  let last = null
  while ((match = regex.exec(logText)) !== null) last = match
  if (!last) return null
  return { added: Number(last[1]), total: Number(last[2]), coveragePct: Number(last[3]) }
}

function findSnappyLog(config, caseDir) {
  const dir = join(caseDir, 'logs')
  if (!existsSync(dir)) return null
  const candidates = readdirSync(dir)
    .filter((f) => /snappyHexMesh/i.test(f) && f.endsWith('.log'))
    .sort()
  return candidates.length ? join(dir, candidates[candidates.length - 1]) : null
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const configFor = (exec) => normalizeConfig(rawConfig, executionCwd(exec))
  const engine = loadEngine(join(config.packageRoot, 'data'))
  const hints = loadHints(join(config.packageRoot, 'data', 'hints'))

  const requireProject = (cfg) => (cfg.configured ? null : unconfiguredPayload(cfg))
  const resolveCase = (cfg, args) => {
    if (!args.caseDir) throw new Error(`caseDir is required, e.g. "${displayPath(cfg, join(cfg.projectRoot, cfg.caseRoot, 'exp-NNN/case'))}"`)
    return resolveProjectPath(cfg, String(args.caseDir))
  }
  const routeById = (id) => {
    const route = engine.routes.find((r) => r.id === id)
    if (!route) throw new Error(`unknown route "${id}" (available: ${engine.routes.map((r) => r.id).join(', ')})`)
    return route
  }
  const scaffoldOptions = (args, stlInputs, np) => {
    const source = args.scaffoldOptions && typeof args.scaffoldOptions === 'object' ? args.scaffoldOptions : {}
    const options = { stl: stlInputs, np }
    for (const key of SCAFFOLD_KEYS) if (source[key] !== undefined) options[key] = source[key]
    if (source.locationsInMesh !== undefined) options.locationInMesh = source.locationsInMesh
    return options
  }
  const troubleshooting = (route, logText) => {
    const hits = (route.failures ?? []).filter((line) => {
      const marker = String(line).split(/[`—-]/)[0].trim()
      return marker.length > 3 && logText.includes(marker)
    })
    return (hits.length ? hits : route.failures ?? []).slice(0, 6)
  }

  function register(def) {
    const tool = defineTool({
      ...def,
      output: jsonOutput,
      async execute(args, exec) {
        try {
          return jsonSafe(await def.execute(args, configFor(exec)))
        } catch (error) {
          return jsonSafe({ error: error.message, tool: def.name })
        }
      },
    })
    ctx.tools.register(tool)
  }

  ctx.skills.register({ ...SKILL, source: 'bundled', version })

  register({
    name: 'mesh_hints',
    description: 'Project knowledge cards for meshing: verified rules, recipes and what each improvement '
      + 'buys you (snappy, cfMesh/pMesh, gmsh route D, quality gate, delivery, rejected routes). '
      + 'Call before choosing a route or when a metric fails. No arguments: catalog.',
    parameters: {
      query: { type: 'string', description: 'Free-text search, e.g. "layers non-ortho" or "interface level".' },
      id: { type: 'string', description: 'Return one card by id, e.g. "quality-gate".' },
      limit: { type: 'number', description: 'Max cards to return (default 5).' },
    },
    async execute(args, config) {
      if (args.id) {
        const card = hints.cards.find((c) => c.id === args.id)
        if (!card) return { found: false, id: args.id, available: hints.cards.map((c) => c.id) }
        return { found: true, card }
      }
      if (args.query) {
        const found = searchHints(hints.cards, args.query, Math.min(20, Math.max(1, args.limit ?? 5)))
        return { ...found, loadErrors: hints.errors.length ? hints.errors : undefined }
      }
      return {
        ...hintsOverview(hints.cards, hints.files, version),
        routes: catalogRoutes(engine).map((r) => r.id),
        profiles: Object.keys(engine.profiles ?? {}),
        next: [
          'mesh_build({ route: "snappy", caseDir: "<empty dir>", scaffold: true, stl: ["stl/x.clean.stl"], scaffoldOptions: {...} })',
          'mesh_check({ caseDir: "experiments/exp-NNN/case", profile: "project", minVol: 1e-14 })',
        ],
      }
    },
  })

  register({
    name: 'mesh_build',
    description: 'Build a volume mesh along a declared route (snappy | cfmesh | gmsh | check). '
      + 'With scaffold:true it writes a verified snappy case from STL + domain — the case and STL are in METERS, '
      + 'scaffoldOptions.stl stays the project STL path (mm, snappy uses scale 0.001). '
      + 'No route: list routes. Logs stay in <caseDir>/logs, the result is a compact JSON summary.',
    parameters: {
      route: { type: 'string', description: 'Route id from data/engine.json: snappy, cfmesh, gmsh, check.' },
      caseDir: { type: 'string', description: 'Case directory (relative to the project root or absolute inside it).' },
      scaffold: { type: 'boolean', description: 'Write a runnable snappy case first (requires stl + scaffoldOptions.domainMin/domainMax/cellSize or cells/locationInMesh).' },
      stl: { type: 'array', items: { type: 'string' }, description: 'STL file(s). Scaffold: surfaces named after file stems. Existing case: copied into constant/triSurface.' },
      scaffoldOptions: { type: 'object', additionalProperties: true, description: 'snappy scaffold: domainMin, domainMax (meters), cells [nx,ny,nz] or cellSize (m), locationInMesh [x,y,z]|[{point,name}], refinementLevels {surfaceName:level}, defaultLevel, layerSurfaces [name], nLayers, symmetryDomain, minVol, maxNonOrtho.' },
      np: { type: 'number', description: 'Parallel subdomains for meshing (default from config; 1 = serial).' },
      splitRegions: { type: 'boolean', description: 'Run splitMeshRegions after meshing (multi-region CHT). Default: true when more than one locationInMesh was given.' },
      gate: { type: 'boolean', description: 'Run the quality gate after meshing (default true).' },
      profile: { type: 'string', description: 'Gate profile: project (default) or gate.' },
      minVol: { type: 'number', description: 'Absolute min cell-pyramid volume (m^3) for the gate, e.g. 1e-14; omit for project default.' },
      overwrite: { type: 'boolean', description: 'Allow scaffolding into a non-empty case directory.' },
      skipBlockMesh: { type: 'boolean', description: 'Do not run blockMesh (case already has a background mesh).' },
      dryRun: { type: 'boolean', description: 'Resolve and print the plan without running (scaffold is previewed in a temp dir).' },
      gmshScript: { type: 'string', description: 'gmsh route: python script that writes the .msh.' },
      gmshArgs: { type: 'array', items: { type: 'string' }, description: 'gmsh route: arguments for the script.' },
      msh: { type: 'string', description: 'gmsh route: output .msh path for gmshToFoam.' },
    },
    async execute(args, config) {
      const blocked = requireProject(config)
      if (blocked) return blocked
      if (!args.route) {
        return {
          configured: true,
          routes: catalogRoutes(engine),
          profiles: Object.keys(engine.profiles ?? {}),
          dataFile: 'data/engine.json',
          next: 'mesh_build({ route: "<id>", caseDir: "..." })',
        }
      }
      const route = routeById(args.route)
      const caseDir = resolveCase(config, args)
      const stlInputs = expandStlInputs(config, args.stl ?? [])
      const np = Math.max(1, Math.floor(Number(args.np) || config.np || 1))
      const locations = args.scaffoldOptions?.locationInMesh ?? args.scaffoldOptions?.locationsInMesh
      const multiLocation = Array.isArray(locations) && locations.length > 1
      const splitRegions = args.splitRegions ?? (args.scaffold === true && multiLocation)
      const runArgs = {
        ...args,
        np,
        splitRegions,
        stl: stlInputs,
        msh: args.msh ? resolveProjectPath(config, String(args.msh)) : '',
        gmshScript: args.gmshScript ? resolveProjectPath(config, String(args.gmshScript)) : '',
      }
      const options = scaffoldOptions({ ...args, np }, stlInputs, np)

      // --- dry run: preview scaffold in a temp dir, then plan the route ---
      if (args.dryRun) {
        let preview = null
        if (args.scaffold) {
          const temp = mkdtempSync(join(tmpdir(), 'mesh-build-scaffold-'))
          try {
            preview = writeSnappyCase(config, temp, options)
          } finally {
            rmSync(temp, { recursive: true, force: true })
          }
        }
        const plan = planRoute(route, makeContext(config, runArgs, caseDir)).map((step) => ({
          index: step.index, name: step.name, when: step.when, run: step.run,
        }))
        return {
          dryRun: true,
          route: route.id,
          caseDir: displayPath(config, caseDir),
          scaffold: preview ? { files: preview.files, surfaces: preview.surfaces, locations: preview.locations, cells: preview.cells, patchType: preview.patchType, units: preview.units } : null,
          plan,
          next: `mesh_build({ route: "${route.id}", caseDir: "${displayPath(config, caseDir)}", scaffold: ${Boolean(args.scaffold)}, ... })`,
        }
      }

      // --- scaffold / install surfaces ---
      const written = {}
      if (args.scaffold) {
        if (existsSync(caseDir) && !isEmptyDir(caseDir) && args.overwrite !== true) {
          return {
            ok: false, phase: 'scaffold',
            error: `case directory is not empty: ${displayPath(config, caseDir)}`,
            next: 'pass overwrite:true, or choose a fresh caseDir',
          }
        }
        Object.assign(written, { scaffold: writeSnappyCase(config, caseDir, options) })
      } else if (stlInputs.length) {
        Object.assign(written, { installed: installStl(config, caseDir, stlInputs) })
      }

      // --- preflight + run ---
      const problems = preflight(config, route, runArgs, caseDir)
      if (problems.length) {
        return { ok: false, phase: 'preflight', route: route.id, caseDir: displayPath(config, caseDir), problems, written }
      }
      const started = Date.now()
      const routeResult = await runRoute(config, route, runArgs, caseDir)
      const payload = {
        ok: routeResult.ok,
        route: route.id,
        caseDir: displayPath(config, caseDir),
        durationMs: Date.now() - started,
        steps: routeResult.steps,
        written,
      }
      if (!routeResult.ok) {
        const logText = routeResult.steps.map((s) => `${s.stdoutTail}\n${s.stderrTail}`).join('\n')
        return {
          ...payload,
          phase: 'route',
          failedStep: routeResult.failedStep.name,
          troubleshooting: troubleshooting(route, logText),
          next: 'fix the failing step (see troubleshooting), then rerun; logs are under <caseDir>/logs',
        }
      }

      // --- optional layers summary from the snappy log ---
      const snappyLog = findSnappyLog(config, caseDir)
      if (snappyLog) {
        try {
          payload.layers = parseSnappyLayers(readFileSync(snappyLog, 'utf8'))
          payload.snappyLog = displayPath(config, snappyLog)
        } catch { /* log unreadable — not fatal */ }
      }

      // --- optional gate ---
      if (args.gate !== false) {
        payload.gate = gateCase(config, caseDir, {
          profile: args.profile ?? 'project',
          minVol: args.minVol ?? args.scaffoldOptions?.minVol,
        })
        payload.verdict = payload.gate.verdict
      }
      payload.next = payload.verdict === 'PASS'
        ? ['tools/deliver/make_delivery.sh --case <case> --name <name> --out <dir> (hint delivery-bundle)']
        : ['read gate.results[].metrics and mesh_hints, adjust geometry/interface level/layers, rerun']
      return payload
    },
  })

  register({
    name: 'mesh_check',
    description: 'Quality verdict for an existing mesh: checkMesh + tools/qa/mesh_gate.sh --profile project '
      + '(threshold checks, not just "Mesh OK") for every region. Returns PASS/FAIL with maxNonOrtho, '
      + 'skewness, minVolume, threshold violations and log paths. Does not modify the case.',
    parameters: {
      caseDir: { type: 'string', description: 'Case directory (relative to the project root or absolute inside it).' },
      regions: { type: 'array', items: { type: 'string' }, description: 'Region names to check; default: auto-detect constant/<region>/polyMesh, else the base case.' },
      profile: { type: 'string', description: 'Gate profile: project (default) or gate.' },
      minVol: { type: 'number', description: 'Absolute minVol threshold (m^3), e.g. 1e-14. Omit for the profile default.' },
    },
    async execute(args, config) {
      const blocked = requireProject(config)
      if (blocked) return blocked
      const caseDir = resolveCase(config, args)
      if (!existsSync(join(caseDir, 'constant'))) {
        return { error: `no constant/ directory in ${displayPath(config, caseDir)}` }
      }
      const gate = gateCase(config, caseDir, {
        profile: args.profile ?? 'project',
        minVol: args.minVol,
        regions: Array.isArray(args.regions) ? args.regions.map(String) : undefined,
      })
      const snappyLog = findSnappyLog(config, caseDir)
      if (snappyLog) {
        try {
          gate.layers = parseSnappyLayers(readFileSync(snappyLog, 'utf8'))
        } catch { /* ignore */ }
      }
      return {
        configured: true,
        caseDir: displayPath(config, caseDir),
        profile: args.profile ?? 'project',
        verdict: gate.verdict,
        pass: gate.pass,
        failingRegions: gate.failingRegions,
        regions: gate.regions,
        layers: gate.layers ?? null,
        results: gate.results.map((r) => ({
          target: r.region,
          pass: r.pass,
          metrics: r.metrics,
          log: r.log,
          stderrTail: r.pass ? undefined : tail(r.stderrTail ?? '', 2000),
        })),
        next: gate.pass
          ? ['mesh is ready: build a delivery bundle (hint delivery-bundle)']
          : ['fix the failing metric — see mesh_hints for the matching card, adjust and rebuild'],
      }
    },
  })
}
