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
  PACKAGE_ROOT, PKG_VERSION, displayPath, diskVersion, executionCwd, expandStlInputs, jsonSafe,
  normalizeConfig, resolveProjectPath, tail, versionInfo,
} from './lib/common.js'
import { gateCase } from './lib/gate.js'
import { CAPABILITIES, ensureHints, provideService } from '../sim-core/lib/index.js'
// Imported from the module itself: the shared index.js may already be cached by another
// plugin in the live DSH process, and a cached module cannot gain new named exports.
import { installationsPayload, withFoam } from '../sim-core/lib/foam.js'
import {
  catalogRoutes, loadEngine, makeContext, planRoute, preflight, renderCommand, runRoute,
} from './lib/routes.js'
import { readCasePatches } from './lib/patches.js'
import { buildHandoff, qualityFromGate, writeHandoff } from '../sim-core/lib/handoff.js'
import { ensureToolkit } from '../sim-core/lib/toolkit.js'
import {
  buildCaseManifest, buildMeshPassport, passportFreshness, readMeshPassport,
  writeCaseManifest, writeMeshPassport,
} from '../sim-core/lib/passport.js'
import { isEmptyDir, installStl, writeSnappyCase } from './lib/scaffold.js'
import { cfmeshUnitsProblem, domainPatchProblem } from './lib/precheck.js'
import { runDelivery } from './lib/deliver.js'
import { SKILL } from './lib/skill.js'

export const name = 'mesh-build'
export const version = PKG_VERSION

/**
 * Version block for tool payloads. A long-running DSH keeps the code it loaded at start,
 * so a stale process must say so out loud instead of silently running old code (DEF-08).
 */
function versionBlock() {
  const onDisk = diskVersion()
  const stale = onDisk !== PKG_VERSION
  return {
    reported: PKG_VERSION,
    onDisk,
    stale,
    ...(stale ? {
      warning: `this DSH process runs mesh-build ${PKG_VERSION} while package.json says ${onDisk}: `
        + 'restart DSH to load the current guards, hints and gate dictionaries',
    } : {}),
  }
}
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

/** Sum cells, worst non-ortho/skew, smallest volume across gate targets. */
function aggregateMetrics(results) {
  const list = (results ?? []).map((r) => r?.metrics).filter(Boolean)
  if (!list.length) return null
  const max = (key) => list.reduce((acc, m) => (m[key] === null || m[key] === undefined ? acc : Math.max(acc ?? -Infinity, m[key])), null)
  const min = (key) => list.reduce((acc, m) => (m[key] === null || m[key] === undefined ? acc : Math.min(acc ?? Infinity, m[key])), null)
  return {
    cells: list.reduce((sum, m) => sum + (m.cells ?? 0), 0),
    maxNonOrtho: max('maxNonOrtho'),
    maxSkewness: max('maxSkewness'),
    minVolume: min('minVolume'),
    failedChecks: max('failedChecks'),
  }
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
  // own cards first, then the mesh-stl cards (STL contract, cleanup, units) — one knowledge base for the agent
  // One catalogue instead of two: mesh-stl cards (STL contract, cleanup, gap rule, gmsh tetra,
  // packing, watertight/units) are what half the documented mesh_hints queries expect, and
  // duplicate ids are dropped by the store, so registering both directories is safe (DEF-15/DEF-16).
  const hints = ensureHints(ctx, {
    owner: name,
    dirs: [join(PACKAGE_ROOT, 'data', 'hints'), join(PACKAGE_ROOT, '..', 'mesh-stl', 'data', 'hints')],
  }).store
  /** Tool handlers, reused by the simMesh capability service below. */
  const handlers = {}

  /** Case-local mode is supported (plan 1.4): report which defaults apply instead of refusing. */
  const PORTABLE_HINT = 'working without sim-project.json: caseDir and STL paths resolve from the current directory, '
    + 'cases default to ./cases, the gate profile to "project" and the quality gate writes its overlay next to the case. '
    + 'Create sim-project.json (sim-core/schemas) to pin units, caseRoots, gate thresholds and OpenFOAM installations.'
  const withPortable = (value, cfg) => {
    if (cfg.configured || !value || typeof value !== 'object' || Array.isArray(value) || value.error) return value
    const next = value.next === undefined ? [] : (Array.isArray(value.next) ? [...value.next] : [value.next])
    if (!next.includes(PORTABLE_HINT)) next.push(PORTABLE_HINT)
    return { ...value, project: cfg.project ?? 'defaults', configured: false, next }
  }
  const resolveCase = (cfg, args, { mustExist = false, hint = null } = {}) => {
    if (!args.caseDir) throw new Error(`caseDir is required, e.g. "${displayPath(cfg, join(cfg.projectRoot, cfg.caseRoot, 'exp-NNN/case'))}"`)
    const dir = resolveProjectPath(cfg, String(args.caseDir))
    if (mustExist && !existsSync(dir)) {
      const reason = hint ?? 'scaffold:true creates it, scaffold:false needs an existing case'
      throw new Error(`case directory not found: ${displayPath(cfg, dir)} — ${reason}`)
    }
    return dir
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
    // snappy optimises against system/meshQualityDict while the gate judges by the profile:
    // writing the same thresholds into the dict keeps both on one set of numbers (exp-022:
    // minTwist -1 in the dict made snappy emit twisted faces that the gate then flagged).
    const profile = config.gate?.profiles?.[args.profile ?? config.gate?.profile]
    if (profile) options.gateThresholds = profile
    return options
  }
  const troubleshooting = (route, logText) => {
    const hits = (route.failures ?? []).filter((line) => {
      const marker = String(line).split(/[`—-]/)[0].trim()
      return marker.length > 3 && logText.includes(marker)
    })
    return (hits.length ? hits : route.failures ?? []).slice(0, 6)
  }

  // Every call may pick an OpenFOAM installation from sim-project.json (`openfoam: "org14"`).
  // Binding happens in one place so build/check/deliver all see the same bashrc.
  function bindFoam(cfg, args, toolName) {
    try {
      return { config: withFoam(cfg, args?.openfoam), error: null }
    } catch (error) {
      return { config: cfg, error: { error: error.message, tool: toolName, openfoam: installationsPayload(cfg) } }
    }
  }

  function register(def) {
    handlers[def.name] = (args, exec) => {
      const bound = bindFoam(exec ? configFor(exec) : config, args, def.name)
      if (bound.error) return bound.error
      return def.execute(args, bound.config)
    }
    const tool = defineTool({
      ...def,
      output: jsonOutput,
      async execute(args, exec) {
        try {
          const bound = bindFoam(configFor(exec), args, def.name)
          if (bound.error) return jsonSafe(bound.error)
          return jsonSafe(withPortable(await def.execute(args, bound.config), bound.config))
        } catch (error) {
          return jsonSafe({ error: error.message, tool: def.name })
        }
      },
    })
    ctx.tools.register(tool)
  }

  try {
    const skills = ctx.get('skills')
    if (skills?.register) skills.register({ ...SKILL, source: 'bundled', version })
  } catch { /* the skills service is optional: tools keep working without it */ }

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
        const card = hints.get(args.id)
        if (!card) return { found: false, id: args.id, available: hints.list().map((c) => c.id) }
        return { found: true, card }
      }
      if (args.query) {
        const found = hints.search(args.query, Math.min(20, Math.max(1, args.limit ?? 5)))
        const { errors } = hints.stats()
        return { ...found, loadErrors: errors.length ? errors : undefined }
      }
      return {
        ...hints.overview(),
        versionInfo: versionInfo(),
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
      openfoam: { type: 'string', description: 'OpenFOAM installation id from sim-project.json (foam.installations, e.g. "org14" or "com2606") or an absolute bashrc path. Omit for the profile default.' },
    },
    async execute(args, config) {
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
      const caseDir = resolveCase(config, args, { mustExist: args.scaffold !== true && args.dryRun !== true })
      // expandStlInputs returns { files, missing } — keep the array, the object is not a path list
      const { files: stlInputs, missing: stlMissing } = expandStlInputs(config, args.stl ?? [])
      if (stlMissing.length) {
        return {
          ok: false,
          phase: 'inputs',
          tool: 'mesh_build',
          error: 'STL not found',
          missing: stlMissing.map((p) => displayPath(config, p)),
          next: 'pass stl: ["<path>.stl"] with paths relative to the project root (or absolute inside it)',
        }
      }
      if (args.scaffold === true && stlInputs.length === 0) {
        return {
          ok: false,
          phase: 'inputs',
          tool: 'mesh_build',
          error: 'scaffold:true needs at least one STL',
          next: 'pass stl: ["<path>.stl"]; surfaces are named after the file stems',
        }
      }
      const np = Math.max(1, Math.floor(Number(args.np) || config.np || 1))
      const locations = args.scaffoldOptions?.locationInMesh ?? args.scaffoldOptions?.locationsInMesh
      // A bare [x, y, z] point is ONE location; only an array of {point, name} objects is multi-region.
      const multiLocation = Array.isArray(locations) && locations.length > 0 && typeof locations[0] === 'object'
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

      // --- dry run: preview scaffold in a temp dir, preflight, then plan the route ---
      if (args.dryRun) {
        const ctx = makeContext(config, runArgs, caseDir)
        let preview = null
        if (args.scaffold) {
          const temp = mkdtempSync(join(tmpdir(), 'mesh-build-scaffold-'))
          try {
            preview = writeSnappyCase(config, temp, options)
          } catch (error) {
            return {
              dryRun: true,
              ok: false,
              phase: 'scaffold',
              route: route.id,
              caseDir: displayPath(config, caseDir),
              error: error.message,
              next: 'check scaffoldOptions: domainMin/domainMax (meters), cellSize or cells, locationInMesh',
            }
          } finally {
            rmSync(temp, { recursive: true, force: true })
          }
        }
        // preflight runs here too: a dry run must say what is missing, not just print a plan
        let problems = preflight(config, route, runArgs, caseDir)
        if (args.scaffold !== true && !existsSync(caseDir)) {
          problems = [`case directory not found: ${displayPath(config, caseDir)} — this route runs in an existing case`, ...problems]
        }
        if (preview) {
          // the scaffold itself writes these two dictionaries
          problems = problems.filter((p) => !p.startsWith('missing system/blockMeshDict')
            && !p.startsWith('missing system/snappyHexMeshDict'))
        }
        const plan = planRoute(route, ctx).map((step) => ({
          index: step.index,
          name: step.name,
          when: step.when,
          run: renderCommand(step.run, ctx),
          unresolved: ['msh', 'gmshScript'].filter((key) => !ctx[key] && String(step.run).includes(`{${key}}`)),
        }))
        return {
          dryRun: true,
          ok: problems.length === 0,
          route: route.id,
          caseDir: displayPath(config, caseDir),
          requires: route.requires ?? [],
          problems,
          scaffold: preview ? { files: preview.files, surfaces: preview.surfaces, locations: preview.locations, cells: preview.cells, patchType: preview.patchType, units: preview.units } : null,
          plan,
          next: problems.length
            ? [`missing input: ${problems.join('; ')}`, problems.some((p) => p.includes('meshDict'))
              ? 'cfmesh needs system/meshDict and mesh_build has no cfmesh scaffold — write the dictionary first (hint cfmesh-layers-tetra)'
              : 'pass the missing argument (gmshScript + msh for the gmsh route)']
            : [`mesh_build({ route: "${route.id}", caseDir: "${displayPath(config, caseDir)}", scaffold: ${Boolean(args.scaffold)}, ... }) without dryRun`],
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
        const scaffold = writeSnappyCase(config, caseDir, options)
        Object.assign(written, { scaffold })
        const patches = [
          ...scaffold.surfaces.map((surface) => ({ name: surface.name, type: 'wall', role: 'surface' })),
          { name: 'world', type: scaffold.patchType, role: 'domain' },
        ]
        try {
          written.manifest = displayPath(config, writeCaseManifest(caseDir, buildCaseManifest({
            solver: splitRegions ? 'foamMultiRun (cht)' : 'foamRun (incompressibleFluid)',
            algorithm: 'snappyHexMesh',
            compressible: false,
            phases: splitRegions ? 2 : 1,
            units: 'm',
            dimension: 3,
            patches,
            createdBy: `${name}@${diskVersion()}`,
          })))
        } catch (error) {
          written.manifestError = error.message
        }
      } else if (stlInputs.length) {
        Object.assign(written, { installed: installStl(config, caseDir, stlInputs) })
      }

      // --- preflight + run ---
      const problems = preflight(config, route, runArgs, caseDir)
      if (problems.length) {
        return { ok: false, phase: 'preflight', route: route.id, caseDir: displayPath(config, caseDir), problems, written }
      }
      // cfMesh has no scale option: a mm surface with metre cell sizes asks for octree level ~17
      // and only stops at the step timeout — refuse with the unit fix instead (DEF-03).
      if (route.id === 'cfmesh') {
        const units = cfmeshUnitsProblem(caseDir, stlInputs)
        if (units) {
          return { ok: false, phase: 'preflight', route: route.id, caseDir: displayPath(config, caseDir), problems: [units], written }
        }
      }
      const started = Date.now()
      const routeResult = await runRoute(config, route, runArgs, caseDir)
      const payload = {
        version: versionBlock(),
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

      // A closed solid meshes fine when locationInMesh lands inside it: the result is the solid
      // interior, the background patch is gone, and nothing used to warn (DEF-17, benchmark H2).
      if (route.id === 'snappy') {
        let patchReport = null
        try { patchReport = readCasePatches(caseDir) } catch { /* boundary unreadable — the gate will report it */ }
        const missingDomain = domainPatchProblem(patchReport, 'world')
        if (missingDomain) {
          return {
            ...payload,
            ok: false,
            phase: 'sanity',
            error: missingDomain,
            next: 'move locationInMesh into the fluid region and rerun (mesh-build/scripts/fluid-point.py picks one)',
          }
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
          profile: args.profile ?? config.gate?.profile,
          minVol: args.minVol ?? args.scaffoldOptions?.minVol,
        })
        payload.verdict = payload.gate.verdict
        try {
          const base = payload.gate.results.find((r) => (r.region ?? 'base') === 'base') ?? payload.gate.results[0]
          const passport = buildMeshPassport({
            caseDir,
            route: route.id,
            regions: payload.gate.regions ?? [],
            gate: base,
            gateTargets: payload.gate.results ?? [],
            units: 'm',
            layers: payload.layers ?? null,
            logs: snappyLog ? [snappyLog] : [],
            generator: { name, version, scaffold: Boolean(args.scaffold) },
          })
          const file = writeMeshPassport(caseDir, passport)
          payload.passport = {
            path: displayPath(config, file),
            cells: passport.cells,
            gate: passport.gate?.verdict ?? null,
            regions: passport.regions,
            freshness: passportFreshness(caseDir, passport),
          }
        } catch (error) {
          payload.passport = { error: error.message }
        }
      }
      // what a solver actually sees: patch names/types, read back from polyMesh/boundary
      try {
        payload.patches = readCasePatches(caseDir)
      } catch { /* boundary unreadable — not fatal */ }
      payload.next = payload.verdict === 'PASS'
        ? ['mesh_deliver({ caseDir, name, outDir, minVol, gateProfile }) — project tools/deliver/make_delivery.sh, or the packaged copy in the bundle (hint delivery-bundle)']
        : ['read gate.results[].metrics and mesh_hints, adjust geometry/interface level/layers, rerun']
      return payload
    },
  })

  register({
    name: 'mesh_check',
    description: 'Quality verdict for an existing mesh: the sim-core JS gate (checkMesh -meshQuality with a complete '
      + 'meshQualityDict) for every region, verdict from the log text (checkMesh exits 0 even on failures). '
      + 'Returns PASS/FAIL with maxNonOrtho, skewness, minVolume, threshold violations and log paths. '
      + 'minVol is absolute (h_min^3/6): pass it per mesh; without it the check is disabled with a warning. '
      + 'Writes mesh-passport.json with the verdict (mesh files untouched).',
    parameters: {
      caseDir: { type: 'string', description: 'Case directory (relative to the project root or absolute inside it).' },
      regions: { type: 'array', items: { type: 'string' }, description: 'Region names to check; default: auto-detect constant/<region>/polyMesh, else the base case.' },
      profile: { type: 'string', description: 'Gate profile: from sim-project.json gate.profile (project), gate or relaxed.' },
      minVol: { type: 'number', description: 'Absolute minVol threshold (m^3), e.g. 1e-14. Omit to use the profile value; when neither is set the check is disabled and reported.' },
      openfoam: { type: 'string', description: 'OpenFOAM installation id from sim-project.json (foam.installations, e.g. "org14" or "com2606") or an absolute bashrc path. Omit for the profile default.' },
    },
    async execute(args, config) {
      const caseDir = resolveCase(config, args, { mustExist: true, hint: 'mesh_check needs a built case with constant/polyMesh' })
      if (!existsSync(join(caseDir, 'constant'))) {
        return { error: `no constant/ directory in ${displayPath(config, caseDir)}` }
      }
      const gate = gateCase(config, caseDir, {
        profile: args.profile ?? config.gate?.profile,
        minVol: args.minVol,
        regions: Array.isArray(args.regions) ? args.regions.map(String) : undefined,
      })
      const snappyLog = findSnappyLog(config, caseDir)
      if (snappyLog) {
        try {
          gate.layers = parseSnappyLayers(readFileSync(snappyLog, 'utf8'))
        } catch { /* ignore */ }
      }
      // Record the verdict: mesh_deliver requires a fresh PASS passport, so the gate that
      // produced the verdict is also the gate that writes it.
      let passport = readMeshPassport(caseDir)
      // Freshness describes the passport as it was BEFORE this check: rebuilding it first made
      // every answer say "fresh" and hid a changed mesh (DEF-09, benchmark G8).
      let freshness = passport ? passportFreshness(caseDir, passport) : null
      try {
        const written = buildMeshPassport({
          caseDir,
          route: passport?.route ?? 'existing-case',
          regions: gate.regions ?? [],
          gate: {
            profile: args.profile ?? config.gate?.profile,
            thresholds: gate.results?.[0]?.thresholds ?? null,
            verdict: gate.verdict,
            pass: gate.pass,
            metrics: aggregateMetrics(gate.results),
          },
          gateTargets: gate.results,
          units: config.units,
          logs: gate.results?.map((r) => r.log).filter(Boolean) ?? [],
          generator: `${name}@${diskVersion()}`,
          environment: {
            id: config.foamSelected?.id ?? null,
            distribution: config.foam?.distribution ?? null,
            version: config.foam?.version ?? null,
            bashrc: config.openfoamBashrc || null,
          },
        })
        writeMeshPassport(caseDir, written)
        passport = written
        freshness ??= passportFreshness(caseDir, written)
      } catch { /* a read-only case still gets the verdict, just no passport */ }
      let patches = null
      try {
        patches = readCasePatches(caseDir)
      } catch { /* ignore */ }
      // File channel for a solver-side workbench (mesh-handoff/1): facts read from the case, no guesses.
      let handoff = null
      try {
        const flatPatches = (patches?.entries ?? []).flatMap((entry) => (entry.patches ?? []).map((p) => ({ ...p, region: entry.region ?? null })))
        const doc = buildHandoff({
          caseDir,
          producer: {
            plugin: name,
            version: diskVersion(),
            openfoam: {
              distribution: config.foam?.distribution ?? null,
              version: config.foam?.version ?? null,
              bashrc: config.openfoamBashrc || null,
            },
          },
          units: config.units === 'm' ? 'm' : 'mm',
          mesh: {
            route: passport?.route ?? 'existing-case',
            cells: passport?.cells ?? null,
            regions: gate.regions ?? [],
            layers: gate.layers
              ? { nLayers: gate.layers.nLayers ?? null, coverage: gate.layers.coverage ?? null }
              : { nLayers: null, coverage: null },
          },
          quality: qualityFromGate({
            profile: args.profile ?? config.gate?.profile,
            minVol: args.minVol ?? gate.results?.[0]?.minVol ?? null,
            verdict: gate.verdict,
            targets: gate.results ?? [],
            passport: passport ? { status: freshness?.status ?? null, createdAt: passport.createdAt } : null,
          }),
          patches: flatPatches,
          next: gate.pass ? [] : [{ tool: 'mesh_check', args: { caseDir: '.' } }],
        })
        handoff = writeHandoff(caseDir, doc)
      } catch (error) {
        handoff = { error: error.message }
      }
      return {
        configured: true,
        version: versionBlock(),
        caseDir: displayPath(config, caseDir),
        handoff: handoff && handoff.file
          ? { file: displayPath(config, handoff.file), bytes: handoff.bytes, verdict: handoff.handoff?.quality?.verdict ?? null, patches: handoff.handoff?.patches?.length ?? 0, next: handoff.handoff?.next ?? [] }
          : handoff,
        profile: args.profile ?? config.gate?.profile,
        verdict: gate.verdict,
        patches,
        pass: gate.pass,
        failingRegions: gate.failingRegions,
        regions: gate.regions,
        layers: gate.layers ?? null,
        advisory: gate.advisory,
        passport: passport ? {
          status: freshness.status,
          fresh: freshness.fresh,
          createdAt: passport.createdAt,
          recordedVerdict: passport.gate?.verdict ?? null,
          recordedCells: passport.cells ?? null,
          agree: passport.gate?.verdict === gate.verdict,
          changed: freshness.changed,
        } : null,
        results: gate.results.map((r) => ({
          target: r.region,
          pass: r.pass,
          failKind: r.failKind ?? null,
          minVolSuggestion: r.minVolSuggestion ?? null,
          advisory: r.advisory ?? [],
          metrics: r.metrics,
          log: r.log,
          stderrTail: r.pass ? undefined : tail(r.stderrTail ?? '', 2000),
        })),
        next: gate.pass
          ? ['mesh is ready: package it with mesh_deliver({caseDir, name, minVol})']
          : ['fix the failing metric — see mesh_hints for the matching card, adjust and rebuild'],
      }
    },
  })

  register({
    name: 'mesh_deliver',
    description: 'Package a mesh that already PASSED the gate into two distributions in one step: an OpenFOAM '
      + 'case (real constant/polyMesh, system/, .foam marker) plus .tar.gz, and an ANSYS/Fluent .msh with a '
      + 'read_mesh.jou journal plus .zip, and a delivery_<name>.{json,md} report. The script re-verifies by '
      + 'running: checkMesh inside the packaged case, per-region interface adjacency for CHT, .msh round-trip '
      + 'and the strict quality gate. Requires a fresh mesh-passport.json (run mesh_check first); force:true '
      + 'overrides that for legacy cases. Multi-region cases are detected automatically; dryRun prints the plan.',
    parameters: {
      caseDir: { type: 'string', description: 'Built case directory (relative to the project root or absolute inside it).' },
      name: { type: 'string', description: 'Delivery name, also the file stem (default: case directory name).' },
      outDir: { type: 'string', description: 'Output directory (default: <caseDir>/deliver).' },
      gateProfile: { type: 'string', description: 'Gate inside the packaged case: project (default), gate, relaxed or none.' },
      minVol: { type: 'number', description: 'Absolute minVol for the delivery gate (m^3), e.g. 1e-14; omit to use sim-project.json gate.minVol, then the script default 1e-14.' },
      regions: { type: 'array', items: { type: 'string' }, description: 'Ship only these regions of a multi-region case.' },
      multiRegion: { type: 'boolean', description: 'Split cellZones into regions in scratch before packaging (--multi-region).' },
      noCombinedMesh: { type: 'boolean', description: 'Do not keep the reference constant/polyMesh_combined in the OF distribution.' },
      skipAnsys: { type: 'boolean', description: 'Skip the Fluent .msh/.zip part.' },
      keepScratch: { type: 'boolean', description: 'Keep the scratch directory used for splitting/round-trip.' },
      force: { type: 'boolean', description: 'Proceed when the mesh passport is missing or stale (the delivery gate still runs).' },
      dryRun: { type: 'boolean', description: 'Validate inputs and print the resolved command without running.' },
      openfoam: { type: 'string', description: 'OpenFOAM installation id from sim-project.json (foam.installations, e.g. "org14" or "com2606") or an absolute bashrc path. Omit for the profile default.' },
    },
    async execute(args, config) {
      let result
      try {
        result = runDelivery(config, args)
      } catch (error) {
        return { error: error.message, tool: 'mesh_deliver' }
      }
      if (result.error) {
        return {
          configured: true,
          tool: 'mesh_deliver',
          verdict: 'BLOCKED',
          reason: result.error,
          message: result.message,
          caseDir: result.plan ? displayPath(config, result.plan.caseDir) : args.caseDir,
          changed: result.guard?.changed,
          recordedVerdict: result.guard?.recordedVerdict ?? null,
          next: result.error === 'passport-missing'
            ? ['run mesh_check({caseDir, minVol}) first, or pass force:true for a legacy case']
            : ['rerun mesh_check after the mesh change, or pass force:true to package as-is'],
        }
      }
      const outDir = displayPath(config, result.plan.outDir)
      const files = {
        openfoam: `${outDir}/openfoam_${result.plan.name}/${result.plan.name}.foam`,
        archive: `${outDir}/openfoam_${result.plan.name}.tar.gz`,
        ansys: result.plan.skipAnsys ? null : `${outDir}/ansys_${result.plan.name}/`,
        reportJson: `${outDir}/delivery_${result.plan.name}.json`,
        reportMd: `${outDir}/delivery_${result.plan.name}.md`,
        log: `${outDir}/deliver.log`,
      }
      // The packaged case carries its own handoff so a workbench can read it without our tools.
      let handoff = null
      if (!result.dryRun && result.ok) {
        try {
          const pkgCase = join(result.plan.outDir, `openfoam_${result.plan.name}`)
          const pkgPatches = readCasePatches(pkgCase)
          const flat = (pkgPatches?.entries ?? []).flatMap((entry) => (entry.patches ?? []).map((p) => ({ ...p, region: entry.region ?? null })))
          const doc = buildHandoff({
            caseDir: pkgCase,
            producer: {
              plugin: name,
              version: diskVersion(),
              openfoam: {
                distribution: config.foam?.distribution ?? null,
                version: config.foam?.version ?? null,
                bashrc: config.openfoamBashrc || null,
              },
            },
            units: config.units === 'm' ? 'm' : 'mm',
            mesh: { route: result.payload?.route ?? null, cells: result.payload?.cells ?? null, regions: result.plan.regions ?? [] },
            quality: {
              profile: result.plan.gateProfile,
              minVol: result.plan.minVol ?? null,
              verdict: 'PASS',
              maxNonOrtho: result.payload?.maxNonOrtho ?? null,
              violations: [],
              passport: null,
            },
            patches: flat,
            files: { delivery: `deliver/delivery_${result.plan.name}.json` },
            history: [{ event: 'delivered', at: new Date().toISOString(), name: result.plan.name }],
          })
          const written = writeHandoff(pkgCase, doc)
          handoff = { file: `${outDir}/openfoam_${result.plan.name}/handoff.json`, bytes: written.bytes }
          // keep the source case in sync: same document, delivery path relative to it
          try { writeHandoff(result.plan.caseDir, doc) } catch { /* read-only source case */ }
        } catch (error) {
          handoff = { error: error.message }
        }
      }
      return {
        configured: true,
        tool: 'mesh_deliver',
        handoff,
        verdict: result.dryRun ? 'PLANNED' : result.ok ? 'DELIVERED' : 'FAILED',
        ok: result.ok === true,
        dryRun: result.dryRun === true,
        name: result.plan.name,
        caseDir: displayPath(config, result.plan.caseDir),
        outDir,
        gateProfile: result.plan.gateProfile,
        minVol: result.plan.minVol,
        command: result.plan.command,
        passport: result.guard?.ok ? {
          status: result.guard.freshness?.status ?? 'fresh',
          recordedVerdict: result.guard.recordedVerdict,
        } : null,
        warnings: result.warnings ?? [],
        delivery: result.payload,
        files,
        durationMs: result.durationMs ?? null,
        rc: result.rc ?? null,
        timedOut: result.timedOut === true,
        stdoutTail: result.stdoutTail || undefined,
        stderrTail: result.stderrTail || undefined,
        next: result.dryRun
          ? ['drop dryRun to package, or adjust gateProfile/minVol/regions']
          : result.ok
            ? [`open in ParaView: paraview ${files.openfoam}`,
               `report: ${files.reportMd}`]
            : [`read the report and deliver.log: ${files.reportMd}`, 'fix the reported check (round-trip, interface, volumes, gate) and rerun'],
      }
    },
  })

  // Capability seam: a solver/Suite plugin calls these handlers instead of importing files.
  provideService(ctx, 'simMesh', {
    version: CAPABILITIES.simMesh,
    owner: name,
    capabilities: ['hints', 'build', 'check', 'deliver'],
    invoke: (tool, args, exec) => {
      const handler = handlers[tool]
      if (!handler) throw new Error(`simMesh: unknown tool "${tool}"`)
      return handler(args, exec)
    },
    hints: (args, exec) => handlers.mesh_hints(args, exec),
    build: (args, exec) => handlers.mesh_build(args, exec),
    check: (args, exec) => handlers.mesh_check(args, exec),
    deliver: (args, exec) => handlers.mesh_deliver(args, exec),
  })

  // meshToolkit (apiVersion 1): the contract-level facade a solver-side workbench resolves at call
  // time. mesh-stl contributes generate/qa into the same object; absent methods answer structurally.
  const toolkit = ensureToolkit(ctx)
  toolkit.register('mesh', (args, exec) => handlers.mesh_build(args, exec), { plugin: name, version, tool: 'mesh_build' })
  toolkit.register('gate', (args, exec) => handlers.mesh_check(args, exec), { plugin: name, version, tool: 'mesh_check' })
  toolkit.register('deliver', (args, exec) => handlers.mesh_deliver(args, exec), { plugin: name, version, tool: 'mesh_deliver' })
  toolkit.register('hints', (args, exec) => handlers.mesh_hints(args, exec), { plugin: name, version, tool: 'mesh_hints' })
}
