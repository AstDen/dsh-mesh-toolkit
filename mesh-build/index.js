/**
 * mesh-build — DSH plugin: volume meshing and quality gate for the pore-scale project.
 *
 * Tools: mesh_hints, mesh_build, mesh_check.
 * Routes (snappy / cfmesh / gmsh / check) live in data/engine.json, knowledge cards in
 * data/hints/*.json, so the toolset can be grown or trimmed by editing data, not code.
 * @module mesh-build
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  PACKAGE_ROOT, PKG_VERSION, displayPath, diskVersion, executionCwd, expandStlInputs, jsonSafe,
  normalizeConfig, readJson, resolveProjectPath, tail, versionInfo,
} from './lib/common.js'
import { gateCase } from './lib/gate.js'
import { minVolFromSetup } from './lib/minvol.js'
import { CAPABILITIES, ensureHints, provideService } from '../sim-core/lib/index.js'
// Imported from the module itself: the shared index.js may already be cached by another
// plugin in the live DSH process, and a cached module cannot gain new named exports.
import { installationsPayload, withFoam } from '../sim-core/lib/foam.js'
import {
  catalogRoutes, loadEngine, makeContext, planRoute, preflight, renderCommand, runRoute,
} from './lib/routes.js'
import { readCasePatches } from './lib/patches.js'
import { parseLayerFaces } from '../sim-core/lib/checkmesh.js'
import { runBash } from '../sim-core/lib/process.js'
import { applyRoleAssignments, applyRetype, listCaseRegions, planRetype } from './lib/patchtypes.js'
import { loadAdvice, planRevision } from './lib/revise.js'
import { caseCellSize, computeFirstLayer, yPlusFromThickness } from './lib/firstlayer.js'
import { buildHandoff, qualityFromGate, readHandoff, writeHandoff } from '../sim-core/lib/handoff.js'
import { ensureToolkit } from '../sim-core/lib/toolkit.js'
import {
  buildCaseManifest, buildMeshPassport, passportFreshness, readMeshPassport,
  writeCaseManifest, writeMeshPassport,
} from '../sim-core/lib/passport.js'
import { isEmptyDir, installStl, writeSnappyCase } from './lib/scaffold.js'
import { scaleSuspicion } from './lib/domain.js'
import { capabilityMatrix, capsSentence, capsSummary, loadCapabilitiesMatrix, probeCaps } from './lib/caps.js'
import { compareTutorialManifest, listTutorials, runTutorial } from './lib/tutorial.js'
import { compareSurfaces, exportPatchTriangles, readTriangles, writeTrianglesStl } from './lib/surfacecheck.js'
import { readStlBboxMm } from './lib/precheck.js'
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
  'domainMin', 'domainMax', 'cells', 'cellSize', 'targetCells', 'domain', 'assumeUnits',
  'locationInMesh', 'locationsInMesh',
  'refinementLevels', 'defaultLevel', 'layerSurfaces', 'nLayers', 'layerThickness',
  'minThickness', 'symmetryDomain', 'minVol', 'maxNonOrtho', 'resolveFeatureAngle', 'expansionRatio', 'minTwist',
  'nCellsBetweenLevels', 'refinementRegions', 'relaxedMaxNonOrtho',
  'autoFluidPoint', 'autoFluidClearanceMm', 'autoFluidSeed',
  'advanced',
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
      scaffoldOptions: { type: 'object', additionalProperties: true, description: 'snappy scaffold: domainMin/domainMax (meters) or domain {type: external|internal|wrap, margins{upstream,downstream,lateral,vertical_top,vertical_bottom}, sizeFactor, flowAxis} derived from the STL bbox; cells [nx,ny,nz] or cellSize (m) or targetCells; locationInMesh [x,y,z]|[{point,name}], refinementLevels {surfaceName:level}, defaultLevel, layerSurfaces [name], nLayers, symmetryDomain, minVol, maxNonOrtho, assumeUnits (skip the unit-suspicion question).' },
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

      // --- unit suspicion: a domain-less run keeps the caller's explicit numbers, but an inferred
      // domain (scaffoldOptions.domain) multiplies the bbox by margins — if the STL may be in metres,
      // ask instead of building a 1000× too large box (plan A6) ---
      if (options.domain && !options.assumeUnits) {
        const bbox = readStlBboxMm(stlInputs[0])
        if (bbox) {
          const scale = scaleSuspicion(bbox)
          if (scale.suspicious) {
            return {
              ok: false,
              phase: 'domain',
              route: route.id,
              caseDir: displayPath(config, caseDir),
              needs_input: [{
                id: 'geometry-units',
                header: 'STL units',
                question: `scaffoldOptions.domain infers the box from the STL bbox (${scale.maxExtentMm.toFixed(1)} mm across). Is this file in millimetres?`,
                options: [
                  { label: 'Millimetres (recommended)', description: 'The bbox is millimetres: build the domain from the numbers as they are.' },
                  { label: 'Metres', description: 'The file is metres: scale it before meshing (surfaceTransformPoints -scale) or pass explicit domainMin/domainMax in metres.' },
                ],
              }],
              suspicion: scale,
              next: ['pass scaffoldOptions.assumeUnits: "mm" to proceed, or give explicit domainMin/domainMax (meters)'],
            }
          }
        }
      }

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
          version: versionBlock(),
          route: route.id,
          caseDir: displayPath(config, caseDir),
          requires: route.requires ?? [],
          problems,
          caps: capsSummary(ctx.features?.caps ?? probeCaps(config)),
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
      const caps = probeCaps(config)
      const payload = {
        version: versionBlock(),
        ok: routeResult.ok,
        route: route.id,
        caseDir: displayPath(config, caseDir),
        durationMs: Date.now() - started,
        steps: routeResult.steps,
        written,
        caps: capsSummary(caps),
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
        const missingDomain = domainPatchProblem(patchReport, 'world', { domainType: options.domain?.type })
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

      // Scaffold warnings (domain mode, target cells, STL outside the domain, cell budget) belong to the
      // answer: they used to stay inside `written.scaffold` and never reached the caller.
      // D-8: when no locationInMesh was given the scaffold picked one from the geometry — say so.
      if (written.scaffold?.locationInMeshSource?.startsWith('auto')) {
        payload.locationInMeshSource = written.scaffold.locationInMeshSource
        payload.locationInMesh = written.scaffold.locations?.map((l) => l.point) ?? null
        payload.fluidPoint = written.scaffold.fluidPoint
      }
      const scaffoldWarnings = written.scaffold?.warnings ?? []
      if (scaffoldWarnings.length) payload.warnings = [...new Set([...(payload.warnings ?? []), ...scaffoldWarnings])]

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
        // D-6: the scaffold knows h_min, so the first gate run does not have to fall back to -1.
        const setupMinVol = args.minVol ?? args.scaffoldOptions?.minVol ?? null
        const derivedGateMinVol = setupMinVol === null || setupMinVol === undefined
          ? minVolFromSetup({
            cellSize_m: written.scaffold?.cellSize_m,
            levels: Object.fromEntries((written.scaffold?.surfaces ?? []).map((s) => [s.name, s.level])),
          })
          : null
        payload.gate = gateCase(config, caseDir, {
          profile: args.profile ?? config.gate?.profile,
          minVol: setupMinVol,
          derivedMinVol: derivedGateMinVol,
          layerFaces: snappyLog ? parseLayerFaces(readFileSync(snappyLog, 'utf8')) : null,
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
    name: 'mesh_surface_check',
    description: 'Fidelity check of the built surface against the reference STL: export the patch faces straight '
      + 'from constant/polyMesh (JS, no OpenFOAM and no version-specific utility), then compare bounding box, area, '
      + 'volume and an approximate Hausdorff distance (triangle-centroid sampling both ways). Catches a domain that '
      + 'clips the geometry (benchmark DEF-11: bboxRel ≈ 0.5) and a snappy mesh that lost features. PASS when '
      + 'bboxRel <= tol and hausdorffRel <= tol; area and volume are reported as diagnostics, because a snapped '
      + 'voxel surface is stair-stepped and legitimately carries more area than the smooth STL.',
    parameters: {
      caseDir: { type: 'string', description: 'Case directory (relative to the project root or absolute inside it).' },
      stl: { type: 'array', items: { type: 'string' }, description: 'Reference STL(s); default: the handoff geometry, else the first file in constant/triSurface.' },
      patches: { type: 'array', items: { type: 'string' }, description: 'Patches to export; default: every non-domain patch (type wall/patch, name not "world").' },
      region: { type: 'string', description: 'Region to export in a multi-region case (default: the base region).' },
      tol: { type: 'number', description: 'Relative tolerance (default 0.05 = 5 %).' },
      samples: { type: 'number', description: 'Triangle-centroid samples per direction (default 2000).' },
      keepStl: { type: 'boolean', description: 'Keep the exported .surface-check.stl instead of deleting it.' },
      openfoam: { type: 'string', description: 'OpenFOAM installation id from sim-project.json or an absolute bashrc path.' },
    },
    async execute(args, config) {
      let caseDir = ''
      try {
        caseDir = resolveCase(config, args, { mustExist: true, hint: 'mesh_surface_check reads constant/polyMesh/boundary and the reference STL' })
      } catch (error) {
        return { error: error.message }
      }
      if (!existsSync(join(caseDir, 'constant', 'polyMesh', 'boundary'))) {
        return { error: `no constant/polyMesh/boundary in ${displayPath(config, caseDir)}: build the mesh first` }
      }
      // reference: explicit STL -> handoff geometry -> the first triSurface file
      const refFiles = []
      if (Array.isArray(args.stl) && args.stl.length) {
        for (const item of args.stl) refFiles.push(resolveProjectPath(config, String(item)))
      } else {
        const handoff = readHandoff(caseDir)
        const claimed = handoff?.geometry?.stl ? [handoff.geometry.stl] : (handoff?.geometry?.stls ?? []).map((s) => s.file)
        for (const item of claimed) if (item) refFiles.push(join(caseDir, String(item)))
        if (!refFiles.length) {
          const tri = join(caseDir, 'constant', 'triSurface')
          const first = existsSync(tri) ? readdirSync(tri).filter((f) => f.endsWith('.stl')).sort()[0] : null
          if (first) refFiles.push(join(tri, first))
        }
      }
      const missing = refFiles.filter((file) => !existsSync(file))
      if (missing.length) return { error: `reference STL not found: ${missing.join(', ')}` }
      if (!refFiles.length) return { error: 'no reference STL: pass stl or put one into constant/triSurface' }

      // patches: explicit list, else the wall-ish patches that carry the geometry
      let patches = Array.isArray(args.patches) ? args.patches.map(String) : []
      if (!patches.length) {
        const report = readCasePatches(caseDir)
        const entry = args.region ? report.entries.find((e) => e.region === args.region) : report.entries[0]
        if (!entry) return { error: `region "${args.region}" not found in ${displayPath(config, caseDir)}` }
        patches = entry.patches
          .filter((p) => p.name !== 'world' && ['wall', 'patch'].includes(p.type))
          .map((p) => p.name)
      }
      if (!patches.length) return { error: 'no patches to export: pass patches explicitly' }

      let exported
      try {
        exported = exportPatchTriangles(caseDir, patches, { region: args.region })
      } catch (error) {
        return {
          error: error.message,
          patches,
          next: ['check the patch names (mesh_check lists them) — a patch that does not exist aborts the export'],
        }
      }

      const exportFile = join(caseDir, '.surface-check.stl')
      if (args.keepStl) writeTrianglesStl(exportFile, exported.triangles)

      // STL units (mm by default) → case metres; the export is always in metres
      const handoffUnits = readHandoff(caseDir)?.units?.stl ?? 'mm'
      const scale = handoffUnits === 'm' ? 1 : 0.001

      let result
      try {
        const referenceTris = []
        for (const file of refFiles) referenceTris.push(readTriangles(file))
        const merged = new Float64Array(referenceTris.reduce((n, arr) => n + arr.length, 0))
        let offset = 0
        for (const arr of referenceTris) { merged.set(arr, offset); offset += arr.length }
        if (scale !== 1) for (let i = 0; i < merged.length; i += 1) merged[i] *= scale
        result = compareSurfaces(merged, exported.triangles, { tol: args.tol ?? 0.05, samples: args.samples ?? 2000 })
      } catch (error) {
        return { error: `comparison failed: ${error.message}`, patches, stl: refFiles.map((f) => displayPath(config, f)) }
      }

      const verdict = result.pass ? 'PASS' : 'FAIL'
      return {
        configured: true,
        tool: 'mesh_surface_check',
        caseDir: displayPath(config, caseDir),
        region: args.region ?? null,
        patches,
        stl: refFiles.map((file) => displayPath(config, file)),
        tol: result.tol,
        verdict,
        pass: result.pass,
        units: { stl: handoffUnits, case: 'm', scale },
        reference: result.reference,
        mesh: result.mesh,
        diffs: result.diffs,
        hausdorff_m: result.hausdorff_m,
        samples: result.samples,
        faces: exported.faces,
        surfaceFile: args.keepStl ? displayPath(config, exportFile) : null,
        note: result.note,
        next: result.pass
          ? ['the surface matches the STL: continue with the solver setup (handoff.json lists the roles and the next steps)']
          : result.diffs.bboxRel > result.tol
            ? ['the bounding box differs: the domain most likely clips the geometry — enlarge domainMin/domainMax (or the domain margins) and rebuild']
            : ['area or Hausdorff differ: refine the surface (refinementLevels) or raise the snap/snap iterations, then rebuild'],
      }
    },
  })

  register({
    name: 'mesh_first_layer',
    description: 'Size the near-wall layers from a y+ target (flat plate: Cf = 0.026·Re^(-1/7) turbulent, 0.664·Re^(-1/2) '
      + 'laminar below Re 5e5; uTau = U·sqrt(Cf/2); the wall distance that carries y+ is y+·nu/uTau and the FIRST CELL is twice '
      + 'that height, clamped to half the near-wall cell; delta = 0.37·L·Re^(-0.2)) and return a scaffoldOptions block for '
      + 'mesh_build — or invert it: given a first-layer thickness, report the y+ it gives. legacyYPlus:true reproduces the '
      + 'pre-1.3 numbers. Pure calculator: no case and no OpenFOAM needed, unless you pass caseDir to read the STL surface names.',
    parameters: {
      uRef: { type: 'number', description: 'Free-stream speed, m/s (required).' },
      lRef: { type: 'number', description: 'Length along the wall (plate/chord), m (required).' },
      nu: { type: 'number', description: 'Kinematic viscosity, m^2/s (default 1.5e-5, air at ~20 °C).' },
      yPlusTarget: { type: 'number', description: 'Target y+ at the wall (default 1).' },
      expansionRatio: { type: 'number', description: 'Geometric growth of the layers (default 1.2).' },
      coverage: { type: 'number', description: 'Fraction of the boundary-layer thickness to cover (default 0.7).' },
      layerSurfaces: { type: 'array', items: { type: 'string' }, description: 'STL surface names to get a scaffoldOptions block.' },
      firstLayer: { type: 'number', description: 'Inverse mode: existing first-layer thickness (m) → report its y+.' },
      cellSize: { type: 'number', description: 'Near-wall cell size after refinement, m (relative layerThickness = lastLayer/cellSize). Omitted: derived from caseDir handoff (background cell / 2^max level).' },
      legacyYPlus: { type: 'boolean', description: 'Reproduce the pre-1.3 numbers: turbulent Cf at every Re, cell height = the y+ wall distance (no ×2), no clamp to half the cell.' },
      caseDir: { type: 'string', description: 'Optional case; its constant/triSurface names fill layerSurfaces and its handoff gives cellSize.' },
    },
    async execute(args, config) {
      try {
        let layerSurfaces = Array.isArray(args.layerSurfaces) ? args.layerSurfaces.map(String) : null
        let caseDir = null
        if (args.caseDir) {
          caseDir = resolveCase(config, args, { mustExist: true, hint: 'mesh_first_layer only reads the surface names' })
          const triSurface = join(caseDir, 'constant', 'triSurface')
          if (existsSync(triSurface) && !layerSurfaces) {
            layerSurfaces = readdirSync(triSurface)
              .filter((name) => name.endsWith('.stl'))
              .map((name) => name.replace(/\.stl$/, ''))
          }
        }
        let cellSize = args.cellSize == null ? null : Number(args.cellSize)
        let cellSizeSource = cellSize == null ? null : 'argument'
        if (cellSize == null && caseDir) {
          // near-wall cell = background cell / 2^max(level); the handoff records both, the case files are the fallback
          const doc = readHandoff(caseDir)
          const bbox = doc?.geometry?.bbox_m
          const cells = doc?.mesh?.selection?.cells
          const levels = doc?.mesh?.selection?.levels ?? {}
          if (bbox?.min && bbox?.max && Array.isArray(cells) && cells.length === 3) {
            const coarse = Math.min(
              (bbox.max[0] - bbox.min[0]) / cells[0],
              (bbox.max[1] - bbox.min[1]) / cells[1],
              (bbox.max[2] - bbox.min[2]) / cells[2],
            )
            const level = Math.max(0, ...Object.values(levels).map((value) => (Array.isArray(value) ? Math.max(...value) : Number(value) || 0)))
            if (Number.isFinite(coarse) && coarse > 0) {
              cellSize = coarse / Math.pow(2, level)
              cellSizeSource = 'handoff'
            }
          }
          if (cellSize == null) {
            const computed = caseCellSize(caseDir)
            if (computed.ok) {
              cellSize = computed.cellSize_m
              cellSizeSource = `case (${(computed.background_m * 1e6).toFixed(1)} µm background, level ${computed.level})`
            }
          }
        }
        const common = { uRef: args.uRef, lRef: args.lRef, nu: args.nu ?? 1.5e-5, cellSize, legacyYPlus: args.legacyYPlus === true }
        const payload = args.firstLayer
          ? { ...yPlusFromThickness({ ...common, firstLayer: args.firstLayer }), mode: 'yplus-from-thickness' }
          : { ...computeFirstLayer({ ...common, yPlusTarget: args.yPlusTarget, expansionRatio: args.expansionRatio, coverage: args.coverage, layerSurfaces }), mode: 'layers-from-yplus' }
        return {
          ...payload,
          caseDir: caseDir ? displayPath(config, caseDir) : null,
          cellSizeSource,
          next: payload.scaffoldOptions
            ? ['mesh_build({ route: "snappy", scaffold: true, stl: [...], scaffoldOptions: { ...domain..., ...scaffoldOptions } }) then mesh_check, or mesh_revise with a mesh-feedback/1 yplus document']
            : ['pass layerSurfaces (or caseDir) to get a scaffoldOptions block; mesh_revise uses the same correlation for the yplus category'],
        }
      } catch (error) {
        return { ok: false, error: error.message, tool: 'mesh_first_layer' }
      }
    },
  })

  register({
    name: 'mesh_patch_types',
    description: 'Assign contract roles (inlet/outlet/wall/symmetry/empty/interface) to existing boundary patches by '
      + 'retyping constant/<region>/polyMesh/boundary — a .bak backup, a before/after diff, no face splitting. Refuses '
      + 'when a patch is missing, when one patch is listed in two roles, when the current type is a topological '
      + 'constraint (empty/cyclic), and when a multi-region case is addressed without region. Updates handoff.json; '
      + 'recheck:true re-runs the gate to show that patch types did not change the metrics.',
    parameters: {
      caseDir: { type: 'string', description: 'Case directory (relative to the project root or absolute inside it).' },
      roles: {
        type: 'object',
        additionalProperties: true,
        description: 'Role → patch names, e.g. { "inlet": ["inlet"], "outlet": ["outlet"], "walls": ["walls", "obstacle"], "symmetry": ["world"] }. '
          + 'Roles: inlet, outlet, wall, symmetry, empty, interface (cyclic/wedge need manual setup).',
      },
      region: { type: 'string', description: 'Region to edit in a multi-region case (required when several regions exist).' },
      dryRun: { type: 'boolean', description: 'Print the planned diff without writing the boundary file.' },
      recheck: { type: 'boolean', description: 'Run the quality gate after the edit and compare the metrics with the handoff.' },
      profile: { type: 'string', description: 'Gate profile for recheck: project (default), gate or relaxed.' },
      minVol: { type: 'number', description: 'Absolute minVol for recheck (m^3); omit to reuse the handoff value.' },
      openfoam: { type: 'string', description: 'OpenFOAM installation id or an absolute bashrc path (needed for recheck only).' },
    },
    async execute(args, config) {
      const caseDir = resolveCase(config, args, { mustExist: true, hint: 'mesh_patch_types edits an existing mesh' })
      const regions = listCaseRegions(caseDir)
      if (!regions.length) return { error: `no constant/polyMesh/boundary in ${displayPath(config, caseDir)}` }
      if (!args.roles || typeof args.roles !== 'object') {
        return {
          error: 'roles is required, e.g. { "inlet": ["inlet"], "outlet": ["outlet"], "walls": ["walls"] }',
          patches: readCasePatches(caseDir),
          regions: regions.map((r) => r || 'base'),
        }
      }
      const plan = planRetype({ caseDir, region: args.region, roles: args.roles })
      if (!plan.ok) {
        return {
          ok: false,
          caseDir: displayPath(config, caseDir),
          region: plan.region ?? (args.region ?? null),
          regions: (plan.regions ?? regions).map((r) => r || 'base'),
          patches: (plan.patches ?? []).map((p) => ({ name: p.name, type: p.type, nFaces: p.nFaces })),
          problems: plan.problems,
          changes: plan.changes ?? [],
          next: ['fix the problems above (names come from patches[].name) and rerun mesh_patch_types',
            'a single patch split into inlet/outlet needs a face set: topoSet + createPatch, then rerun'],
        }
      }
      const summary = {
        caseDir: displayPath(config, caseDir),
        region: plan.region || 'base',
        file: displayPath(config, plan.file),
        dryRun: Boolean(args.dryRun),
        changes: plan.changes,
        unchanged: plan.notes,
        patches: null,
        backup: null,
        handoff: null,
        recheck: null,
      }
      if (args.dryRun) {
        summary.patches = plan.patches.map((p) => ({ name: p.name, type: p.type, nFaces: p.nFaces }))
        summary.next = ['drop dryRun to write the boundary file (a .bak backup is kept)']
        return summary
      }

      let applied
      try {
        applied = applyRetype(plan)
      } catch (error) {
        return { ...summary, error: error.message, next: ['nothing was changed: fix the reported problem and rerun'] }
      }
      summary.backup = applied.backup ? displayPath(config, applied.backup) : null
      summary.before = applied.before
      summary.after = applied.after
      summary.patches = applied.patches.map(({ bodyStart, bodyEnd, ...p }) => ({ name: p.name, type: p.type, nFaces: p.nFaces }))

      // Keep the handoff in step with the physical boundary: roles are the contract's view of it.
      const previous = readHandoff(caseDir)
      try {
        const patchesNow = readCasePatches(caseDir)
        const flat = (patchesNow?.entries ?? []).flatMap((entry) => (entry.patches ?? []).map((p) => ({ ...p, region: entry.region ?? null })))
        // inlet and outlet are both type `patch`: the semantic role lives only in this document, so carry
        // the previous assignments forward and add the ones applied now.
        const assignedRoles = {}
        for (const p of previous?.patches ?? []) {
          if (p?.name && p.role && p.role !== 'unknown' && (p.type === 'patch' || p.type == null)) assignedRoles[p.name] = p.role
        }
        for (const change of applied.changes) assignedRoles[change.name] = change.role
        const doc = buildHandoff({
          caseDir,
          producer: {
            plugin: name,
            version: diskVersion(),
            openfoam: {
              distribution: config.foam?.distribution || null,
              version: config.foam?.version || null,
              bashrc: config.openfoamBashrc || null,
            },
          },
          units: config.units === 'm' ? 'm' : 'mm',
          mesh: { route: previous?.mesh?.route ?? 'existing-case', cells: previous?.mesh?.cells ?? null, regions: regions.filter(Boolean) },
          quality: previous?.quality ?? null,
          patches: flat,
          assignedRoles,
          history: [
            ...(previous?.history ?? []),
            { event: 'patch-types', at: new Date().toISOString(), changes: applied.changes.map((c) => `${c.name}: ${c.from} -> ${c.to}`) },
          ],
        })
        const written = writeHandoff(caseDir, applyRoleAssignments(doc, assignedRoles))
        summary.handoff = {
          file: displayPath(config, written.file),
          bytes: written.bytes,
          roles: written.handoff.roles,
          flowReady: written.handoff.next.every((n) => n.tool !== 'mesh_patch_types'),
          next: written.handoff.next,
        }
      } catch (error) {
        summary.handoff = { error: error.message }
      }

      if (args.recheck) {
        const before = previous?.quality ?? null
        const gate = gateCase(config, caseDir, {
          profile: args.profile ?? config.gate?.profile,
          minVol: args.minVol ?? before?.minVol ?? undefined,
        })
        const metrics = gate.results?.[0]?.metrics ?? {}
        summary.recheck = {
          verdict: gate.verdict,
          cells: metrics.cells ?? null,
          maxNonOrtho: metrics.maxNonOrtho ?? null,
          minVolume: metrics.minVolume ?? null,
          sameAsRecorded: before
            ? metrics.cells === before.cells && metrics.maxNonOrtho === before.maxNonOrtho && metrics.minVolume === before.minVolume
            : null,
          recorded: before ? { verdict: before.verdict, cells: before.cells, maxNonOrtho: before.maxNonOrtho, minVolume: before.minVolume } : null,
        }
      }

      const touched = applied.changes.length > 0
      summary.next = summary.recheck
        ? [`handoff.json updated (${summary.handoff?.file ?? 'not written'}); the mesh itself is unchanged — deliver with mesh_deliver`]
        : touched
          ? ['run mesh_check({caseDir, minVol}) to refresh the passport: the boundary file changed, so the old passport is stale',
            'then deliver with mesh_deliver']
          : ['nothing to retype: the roles were already assigned; the handoff is up to date, the passport stays fresh',
            summary.handoff?.flowReady ? 'ready for a solver: deliver with mesh_deliver' : 'assign the missing roles (inlet/outlet) or split patches with topoSet+createPatch']
      return summary
    },
  })

  register({
    name: 'mesh_revise',
    description: 'Plan A3: turn a mesh-feedback/1 document into the NEXT revision of the mesh. The reaction table is data '
      + '(data/advice.json): category -> ladder of ops -> ceiling, and the rung is counted from the revisions recorded in '
      + 'handoff.json. apply:false (default) returns the plan; apply:true rebuilds with mesh_build (scaffold, same STL and '
      + 'domain from the handoff), re-runs mesh_check, appends the revision to history[]. Category patch-roles calls '
      + 'mesh_patch_types instead of rebuilding; stl-quality stops and asks for stl_check + cleanup. After the ceiling the '
      + 'tool returns {ok:false, escalated:true, options:[...]} instead of repeating parameters.',
    parameters: {
      caseDir: { type: 'string', description: 'Case directory (relative to the project root or absolute inside it).' },
      feedback: { type: 'object', additionalProperties: true, description: 'mesh-feedback/1 document: {schemaVersion, requestId, attempt, category, severity, evidence{metrics}, expected, changes, note}.' },
      feedbackFile: { type: 'string', description: 'Alternative to feedback: path to a mesh-feedback/1 JSON file.' },
      attempt: { type: 'number', description: 'Attempt number (default: feedback.attempt, else the number of earlier revisions of this category + 1).' },
      apply: { type: 'boolean', description: 'false (default) = plan only; true = rebuild now.' },
      profile: { type: 'string', description: 'Gate profile for the re-check: project (default), gate or relaxed.' },
      minVol: { type: 'number', description: 'Absolute minVol for the re-check; default: the value recorded in handoff.json.' },
      np: { type: 'number', description: 'Parallel subdomains for the rebuild (default from config).' },
      openfoam: { type: 'string', description: 'OpenFOAM installation id or an absolute bashrc path.' },
    },
    async execute(args, config) {
      const caseDir = resolveCase(config, args, { mustExist: true, hint: 'mesh_revise needs an existing case with handoff.json' })
      let feedback = args.feedback ?? null
      if (!feedback && args.feedbackFile) {
        const file = resolveProjectPath(config, args.feedbackFile)
        if (!existsSync(file)) return { error: `feedback file not found: ${displayPath(config, file)}` }
        try {
          feedback = JSON.parse(readFileSync(file, 'utf8'))
        } catch (error) {
          return { error: `feedback file is not valid JSON (${displayPath(config, file)}): ${error.message}` }
        }
      }
      if (!feedback) return { error: 'feedback is required (a mesh-feedback/1 object) — or pass feedbackFile' }

      const handoff = readHandoff(caseDir)
      if (!handoff) {
        return {
          error: `no handoff.json in ${displayPath(config, caseDir)}: run mesh_check first — the revision needs the baseline (route, domain, levels, minVol) it is judged against`,
        }
      }
      const loaded = loadAdvice(join(config.packageRoot, 'data'))
      if (loaded.error) return { error: loaded.error }

      const plan = planRevision({ feedback, handoff: { ...handoff, caseDir }, advice: loaded.advice, attempt: args.attempt })
      const base = {
        caseDir: displayPath(config, caseDir),
        category: plan.category ?? feedback.category ?? null,
        attempt: plan.attempt ?? null,
      }
      if (!plan.ok) {
        return {
          ...base,
          ok: false,
          escalated: plan.escalated === true,
          plan,
          options: plan.options ?? null,
          problems: plan.problems,
          next: plan.escalated
            ? ['show options to the user (contract §3.4) and start a new attempt with the chosen variant']
            : ['fix the feedback document (or add the missing evidence) and call mesh_revise again'],
        }
      }
      if (!args.apply) {
        return {
          ...base,
          ok: true,
          dryRun: true,
          plan,
          next: [`apply:true rebuilds with: ${plan.actions.map((a) => a.action).join('; ')}`],
        }
      }
      if (plan.stop === 'stl-quality') {
        return {
          ...base,
          ok: false,
          verdict: 'BLOCKED',
          plan,
          next: ['run stl_check({ stl, cleanup: true }) on the geometry, then rebuild from the cleaned file (mesh_build) and mesh_revise again'],
        }
      }

      // patch-roles: retype the boundary, no rebuild
      if (plan.request?.patchRoles) {
        const summary = await handlers.mesh_patch_types({
          caseDir,
          roles: plan.request.patchRoles,
          recheck: true,
          profile: args.profile ?? config.gate?.profile,
          minVol: args.minVol,
        })
        return { ...base, ok: summary?.verdict === 'PASS' || summary?.ok === true, action: 'patch-types', summary, plan }
      }

      const selection = handoff.mesh?.selection ?? {}
      const domain = handoff.domain?.bbox_m ?? handoff.geometry?.bbox_m ?? null
      const location = handoff.domain?.locationInMesh ?? null
      const stls = (handoff.geometry?.stls ?? []).map((s) => s.file).filter(Boolean)
      if (!domain || !location || !stls.length) {
        return {
          ...base,
          ok: false,
          verdict: 'BLOCKED',
          problems: ['handoff.json has no domain.bbox_m/locationInMesh/geometry.stls: cannot rebuild automatically — rebuild manually with mesh_build and pass the same request'],
          plan,
        }
      }

      // Stage the STL inside the case so scaffold can copy it over constant/triSurface.
      const staging = join(caseDir, 'revise-input')
      rmSync(staging, { recursive: true, force: true })
      const staged = []
      for (const rel of stls) {
        const abs = join(caseDir, rel)
        if (!existsSync(abs)) continue
        const dirname = join(staging)
        if (!existsSync(dirname)) mkdirSync(dirname, { recursive: true })
        const dest = join(staging, rel.split('/').pop())
        copyFileSync(abs, dest)
        staged.push(dest)
      }
      if (!staged.length) return { ...base, ok: false, verdict: 'BLOCKED', problems: [`no STL found under ${displayPath(config, caseDir)}/constant/triSurface`], plan }

      const so = plan.request?.scaffoldOptions ?? {}
      const buildArgs = {
        route: plan.request?.route ?? handoff.mesh?.route ?? 'snappy',
        caseDir,
        stl: staged,
        scaffold: true,
        overwrite: true,
        gate: false,
        np: args.np ?? config.np ?? 1,
        scaffoldOptions: {
          domainMin: so.domainMin ?? domain.min,
          domainMax: so.domainMax ?? domain.max,
          cells: so.cells ?? selection.cells ?? undefined,
          cellSize: so.cells ? undefined : selection.cellSize_m ?? undefined,
          locationInMesh: location,
          refinementLevels: so.refinementLevels ?? selection.levels ?? undefined,
          defaultLevel: selection.defaultLevel ?? undefined,
          nLayers: so.nLayers,
          layerSurfaces: so.layerSurfaces,
          layerThickness: so.layerThickness,
          expansionRatio: so.expansionRatio,
          minTwist: so.minTwist,
          resolveFeatureAngle: so.resolveFeatureAngle,
          minVol: so.minVol ?? args.minVol ?? handoff.quality?.minVol ?? undefined,
        },
      }
      const built = await handlers.mesh_build(buildArgs)
      rmSync(staging, { recursive: true, force: true })
      if (built?.ok === false || built?.error) {
        return {
          ...base,
          ok: false,
          verdict: 'BUILD-FAILED',
          plan,
          build: { ok: false, phase: built?.phase ?? null, error: built?.error ?? null, problems: built?.problems ?? null, failedStep: built?.failedStep ?? null },
          next: ['read build.problems/failedStep; the advice ladder already moved one rung — call mesh_revise again with the same feedback for the next rung'],
        }
      }

      const checked = await handlers.mesh_check({
        caseDir,
        profile: args.profile ?? config.gate?.profile,
        minVol: args.minVol ?? plan.request?.gateMinVol ?? handoff.quality?.minVol ?? undefined,
      })
      const verdict = checked?.verdict ?? 'FAIL'
      const metrics = checked?.results?.[0]?.metrics ?? {}
      const stored = readHandoff(caseDir)
      const record = {
        event: 'revision',
        at: new Date().toISOString(),
        attempt: plan.attempt,
        category: plan.category,
        strategy: plan.strategy,
        changes: plan.actions.map((a) => a.action),
        verdict,
      }
      let handoffFile = stored?.file ?? null
      if (stored) {
        const doc = { ...stored, history: [...(stored.history ?? []), record] }
        writeHandoff(caseDir, doc)
        handoffFile = join(caseDir, 'handoff.json')
      }
      return {
        ...base,
        ok: verdict === 'PASS',
        verdict,
        plan,
        changes: plan.actions.map((a) => a.action),
        rebuilt: {
          cells: metrics.cells ?? null,
          maxNonOrtho: metrics.maxNonOrtho ?? null,
          maxSkewness: metrics.maxSkewness ?? null,
          minVolume: metrics.minVolume ?? null,
        },
        handoff: { file: displayPath(config, handoffFile ?? ''), verdict, flowReady: stored?.flowReady ?? null },
        next: verdict === 'PASS'
          ? ['deliver with mesh_deliver, or send the handoff to the workbench']
          : ['read rebuilt + gate violations; call mesh_revise again with the same feedback (the next rung) or escalate after the ceiling'],
      }
    },
  })

  register({
    name: 'mesh_capabilities',
    description: 'What this OpenFOAM installation actually accepts: distribution and version, the executables '
      + '(cfMesh is OpenCFD-only, surfaceFeatures is Foundation-only), and the dictionary keys of the installed build '
      + '(blockMesh `scale` vs `convertToMeters`, snappy `minMedialAxisAngle` vs `minMedianAxisAngle`, '
      + '`locationsInMesh`, `castellatedBufferLayer`). The keys are read from $WM_PROJECT_DIR/etc/caseDicts/annotated, '
      + 'so a patched build is described correctly instead of being guessed from a version table.',
    parameters: {
      openfoam: { type: 'string', description: 'OpenFOAM installation id from sim-project.json or an absolute bashrc path; omitted = the profile default.' },
      refresh: { type: 'boolean', description: 'Ignore the cached probe and re-read the installation.' },
    },
    async execute(args, config) {
      const caps = probeCaps(config)
      const matrix = capabilityMatrix(caps, loadCapabilitiesMatrix(join(config.packageRoot, 'data')))
      return {
        configured: true,
        tool: 'mesh_capabilities',
        bashrc: caps.bashrc,
        distribution: caps.distribution,
        version: caps.version,
        project: caps.project,
        commands: caps.commands,
        features: caps.features,
        dictKeys: caps.dictKeys,
        dicts: caps.dicts,
        matrix,
        notes: caps.notes,
        summary: capsSentence(caps),
        next: [
          'mesh_build reports the same block as `caps`; scaffolded dictionaries follow dictKeys',
          'matrix: utilities x snappyHexMesh keys x this build, live probe merged with data/capabilities.json',
          caps.features.cfmesh
            ? 'cfMesh is available: route "cfmesh" needs system/meshDict (see the cfmesh hint card)'
            : 'cfMesh is not in this installation: use route "snappy" or "gmsh" (the preflight refuses cfmesh on org builds)',
        ],
      }
    },
  })


  register({
    name: 'mesh_tutorial',
    description: 'Reproduce an OpenFOAM mesh tutorial with one call: list the shipped cases (family, steps, '
      + 'utilities, manual-only), then copy a case into the project, run its Allrun pipeline step by step '
      + '(each `runApplication` line becomes a logged step, never a shell), gate the result with mesh_check '
      + 'and write tutorial-manifest.json (cells, patches, metrics, verdict, duration). '
      + '`steps: "mesh-only"` (default) stops before the first solver/motion utility. '
      + 'A utility missing from the build is refused up front, never half-run.',
    parameters: {
      list: { type: 'boolean', description: 'List the tutorials instead of running one (families, controlDicts, runnable vs manual, missing utilities).' },
      case: { type: 'string', description: 'Tutorial case id relative to tutorials/mesh, e.g. "snappyHexMesh/flange" or "blockMesh/sphere7".' },
      out: { type: 'string', description: 'Output case directory inside the project (default experiments/tut-<n>_<slug>); the tutorial itself is never modified.' },
      np: { type: 'number', description: 'Ranks for runParallel steps. Must equal numberOfSubdomains in the case decomposeParDict — mismatch is refused, not patched.' },
      steps: { type: 'string', description: 'mesh-only (default: stop before the first solver/motion utility), all, or a comma list of utility names (blockMesh,snappyHexMesh).' },
      force: { type: 'boolean', description: 'Replace an existing output directory.' },
      allowManual: { type: 'boolean', description: 'Also run a case whose Allrun uses shell control flow (for loops, if, wmake): default is to refuse with the list of unsupported lines.' },
      keepGoing: { type: 'boolean', description: 'Continue after a failing step, like the Allrun itself (no `set -e`). Needed for cases whose first pass exits on purpose (motorBike_leakDetection writes leakPath, then run with useLeakClosure true). Failures stay in failedSteps; the gate decides the verdict.' },
      profile: { type: 'string', description: 'Gate profile for the final verdict (default gate — a tutorial mesh is an oracle, not project geometry).' },
      minVol: { type: 'number', description: 'Absolute minVol for the gate (m^3); omitted = profile value, else the check is disabled and reported.' },
      timeoutMs: { type: 'number', description: 'Per-step timeout (default 1800000).' },
      dryRun: { type: 'boolean', description: 'Parse and show the plan without copying or running anything.' },
      compare: { type: 'object', additionalProperties: true, description: 'Optional { baseline: <path to a baseline manifest or fixtures json>, cellsTolerance, nonOrthoTolerance } to compare the run against a saved oracle.' },
      openfoam: { type: 'string', description: 'OpenFOAM installation id from sim-project.json (com2606, com2512, org14) or an absolute bashrc path.' },
    },
    async execute(args, config) {
      if (args.list) {
        const listing = listTutorials(config, { parse: true })
        if (!listing.ok) return listing
        return {
          configured: true, version: versionBlock(), tool: 'mesh_tutorial', action: 'list',
          bashrc: listing.bashrc, project: listing.project, root: listing.root, counts: listing.counts,
          families: listing.families,
          cases: listing.cases.map((c) => ({
            id: c.id, family: c.family, controlDicts: c.controlDict, steps: c.stepCount,
            utils: c.utils, solvers: c.solvers ?? [], manual: c.manual, missingUtils: c.missingUtils,
            runnable: c.runnable,
          })),
          next: ['mesh_tutorial({ case: "snappyHexMesh/flange", np: 4 }) — np must match the case decomposeParDict',
            'cases with manual=true need allowManual:true or a hand-written pipeline'],
        }
      }
      if (!args.case) return { ok: false, error: 'pass case:"<family>/<name>" or list:true', hint: 'mesh_tutorial({ list: true })' }
      const run = runTutorial(config, {
        case: args.case,
        out: args.out,
        np: args.np,
        steps: args.steps,
        force: Boolean(args.force),
        allowManual: Boolean(args.allowManual),
        keepGoing: Boolean(args.keepGoing),
        profile: args.profile,
        minVol: args.minVol,
        timeoutMs: args.timeoutMs,
        dryRun: Boolean(args.dryRun),
      })
      if (!run.ok) return run
      if (args.compare?.baseline) {
        try {
          const baseline = readJson(resolveProjectPath(config, args.compare.baseline))
          run.comparison = compareTutorialManifest(baseline, run, {
            cellsTolerance: args.compare.cellsTolerance,
            nonOrthoTolerance: args.compare.nonOrthoTolerance,
          })
        } catch (error) {
          run.comparison = { ok: false, error: error.message }
        }
      }
      return { configured: true, version: versionBlock(), tool: 'mesh_tutorial', ...run }
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
      writeFields: { type: 'string', description: 'Pass `-writeFields` to checkMesh, e.g. "(nonOrthoAngle)" or "(nonOrthoAngle skewness)": the per-cell quality field is written into the disposable overlay (0/ is copied, never the case) and summarised as {field, n, min, max, avg}.' },
      openfoam: { type: 'string', description: 'OpenFOAM installation id from sim-project.json (foam.installations, e.g. "org14" or "com2606") or an absolute bashrc path. Omit for the profile default.' },
    },
    async execute(args, config) {
      const caseDir = resolveCase(config, args, { mustExist: true, hint: 'mesh_check needs a built case with constant/polyMesh' })
      if (!existsSync(join(caseDir, 'constant'))) {
        return { error: `no constant/ directory in ${displayPath(config, caseDir)}` }
      }
      const writeFields = typeof args.writeFields === 'string' && args.writeFields.trim() ? args.writeFields.trim() : null
      const snappyLog = findSnappyLog(config, caseDir)
      const snappyText = snappyLog ? readFileSync(snappyLog, 'utf8') : null
      const gate = gateCase(config, caseDir, {
        profile: args.profile ?? config.gate?.profile,
        minVol: args.minVol,
        regions: Array.isArray(args.regions) ? args.regions.map(String) : undefined,
        writeFields,
        layerFaces: snappyText ? parseLayerFaces(snappyText) : null,
      })
      if (snappyLog && snappyText) {
        try {
          // D-7: keep the face-coverage block the gate produced and add the cell-count view,
          // instead of replacing one with the other.
          const cellLayers = parseSnappyLayers(snappyText)
          gate.layers = {
            ...(gate.layers ?? {}),
            added: cellLayers.added,
            total: cellLayers.total,
            coveragePct: cellLayers.coveragePct,
          }
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
            distribution: config.foam?.distribution || null,
            version: config.foam?.version || null,
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
        // Keep the semantic roles mesh_patch_types assigned: type `patch` alone cannot tell inlet from outlet.
        const previous = readHandoff(caseDir)
        const assignedRoles = {}
        for (const p of previous?.patches ?? []) {
          if (p?.name && p.role && p.role !== 'unknown' && (p.type === 'patch' || p.type == null)) assignedRoles[p.name] = p.role
        }
        // history is an audit trail: keep the earlier events and append this verdict
        const history = [
          ...(previous?.history ?? []),
          { event: 'gate', at: new Date().toISOString(), verdict: gate.verdict, profile: args.profile ?? config.gate?.profile, minVol: args.minVol ?? gate.results?.[0]?.minVol ?? null },
        ]
        const doc = buildHandoff({
          caseDir,
          producer: {
            plugin: name,
            version: diskVersion(),
            openfoam: {
              distribution: config.foam?.distribution || null,
              version: config.foam?.version || null,
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
          assignedRoles,
          history,
          next: gate.pass ? [] : [{ tool: 'mesh_check', args: { caseDir: '.' } }],
        })
        handoff = writeHandoff(caseDir, applyRoleAssignments(doc, assignedRoles))
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
        minVol: gate.results?.[0]?.minVol ?? null,
        minVolSource: gate.results?.[0]?.minVolSource ?? null,
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
          minVol: r.minVol ?? null,
          minVolSource: r.minVolSource ?? null,
          minVolSuggestion: r.minVolSuggestion ?? null,
          layers: r.layers ?? null,
          advisory: r.advisory ?? [],
          metrics: r.metrics,
          log: r.log,
          ...(r.writeFields ? { writeFields: r.writeFields, writtenFields: r.writtenFields ?? [] } : {}),
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
                distribution: config.foam?.distribution || null,
                version: config.foam?.version || null,
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
    capabilities: ['hints', 'build', 'check', 'deliver', 'patchTypes', 'revise'],
    invoke: (tool, args, exec) => {
      const handler = handlers[tool]
      if (!handler) throw new Error(`simMesh: unknown tool "${tool}"`)
      return handler(args, exec)
    },
    hints: (args, exec) => handlers.mesh_hints(args, exec),
    build: (args, exec) => handlers.mesh_build(args, exec),
    check: (args, exec) => handlers.mesh_check(args, exec),
    deliver: (args, exec) => handlers.mesh_deliver(args, exec),
    patchTypes: (args, exec) => handlers.mesh_patch_types(args, exec),
    revise: (args, exec) => handlers.mesh_revise({ apply: true, ...args }, exec),
  })

  // meshToolkit (apiVersion 1): the contract-level facade a solver-side workbench resolves at call
  // time. mesh-stl contributes generate/qa into the same object; absent methods answer structurally.
  const toolkit = ensureToolkit(ctx)
  toolkit.register('mesh', (args, exec) => handlers.mesh_build(args, exec), { plugin: name, version, tool: 'mesh_build' })
  toolkit.register('gate', (args, exec) => handlers.mesh_check(args, exec), { plugin: name, version, tool: 'mesh_check' })
  toolkit.register('deliver', (args, exec) => handlers.mesh_deliver(args, exec), { plugin: name, version, tool: 'mesh_deliver' })
  toolkit.register('patchTypes', (args, exec) => handlers.mesh_patch_types(args, exec), { plugin: name, version, tool: 'mesh_patch_types' })
  toolkit.register('revise', (args, exec) => handlers.mesh_revise({ apply: true, ...args }, exec), { plugin: name, version, tool: 'mesh_revise' })
  toolkit.register('hints', (args, exec) => handlers.mesh_hints(args, exec), { plugin: name, version, tool: 'mesh_hints' })
}
