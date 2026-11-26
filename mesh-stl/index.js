/**
 * mesh-stl — DSH plugin: STL generation and STL QA for the pore-scale project.
 *
 * Tools: stl_hints, stl_generate, stl_check.
 * Knowledge and the generator registry are JSON data (data/hints, data/generators.json),
 * so tools can be extended by editing data, not code.
 * @module mesh-stl
 */
import { existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  PACKAGE_ROOT, PKG_VERSION, displayPath, executionCwd, jsonSafe, normalizeConfig, resolveProjectPath, stem,
  unconfiguredPayload, versionInfo,
} from './lib/common.js'
import {
  catalogFamilies, loadRegistry, qaFile, runFamily,
} from './lib/generators.js'
import { CAPABILITIES, ensureHints, provideService } from '../sim-core/lib/index.js'
import { appendRegistryRow, formatBbox, registryFilePath } from './lib/registry.js'
import { SKILL } from './lib/skill.js'

export const name = 'mesh-stl'
export const version = PKG_VERSION
export const inject = ['tools', 'skills']

const text = (value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }]
const jsonOutput = { schema: { type: 'json' }, render: (_args, value) => text(value) }

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {unknown} rawConfig
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const configFor = (exec) => normalizeConfig(rawConfig, executionCwd(exec))
  const registry = loadRegistry(join(config.packageRoot, 'data'))
  // One knowledge store per agent: every Sim plugin registers its own data/hints into `simHints`,
  // so snappy/gate cards from mesh-build are visible here without reading its files by path.
  const hints = ensureHints(ctx, { owner: name, dirs: [join(PACKAGE_ROOT, 'data', 'hints')] }).store
  /** Tool handlers, reused by the simGeometry capability service below. */
  const handlers = {}

  /** Null when the project is configured, otherwise the actionable payload. */
  const requireProject = (cfg) => (cfg.configured ? null : unconfiguredPayload(cfg))

  function register(def) {
    const handler = (args, exec) => def.execute(args, exec ? configFor(exec) : config)
    handlers[def.name] = handler
    const tool = defineTool({
      ...def,
      output: jsonOutput,
      async execute(args, exec) {
        const value = await def.execute(args, configFor(exec))
        return jsonSafe(value)
      },
    })
    ctx.tools.register(tool)
  }

  try {
    const skills = ctx.get('skills')
    if (skills?.register) skills.register({ ...SKILL, source: 'bundled', version })
  } catch { /* the skills service is optional: tools keep working without it */ }

  register({
    name: 'stl_hints',
    description: 'Project knowledge cards for STL/geometry: verified rules with evidence, recipes and '
      + 'what they improve. Call before designing geometry or debugging a bad STL. No arguments: catalog.',
    parameters: {
      query: { type: 'string', description: 'Free-text search, e.g. "minVol layers" or "cadquery tolerance".' },
      id: { type: 'string', description: 'Return one card by id, e.g. "snappy-minvol".' },
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
        dataDir: 'data/hints',
        loadErrors: hints.stats().errors.length ? hints.stats().errors : undefined,
        next: [
          'stl_generate({ family: "fcc-cell" }) — list presets and run a generator',
          'stl_check({ stl: "<file>.stl", cleanup: true, register: true }) — verify and register',
          'mesh_build({ route: "snappy", caseDir: "..." }) — turn the STL into a volume mesh',
        ],
      }
    },
  })

  register({
    name: 'stl_generate',
    description: 'Generate STL geometry from a generator family (data/generators.json). '
      + 'Built-in JS families (primitive, stratified-channel, box-array) need no Python and no project data; '
      + 'python families run the packaged scripts in generators/ (generators.root can switch to the project tree). '
      + 'No family: list families and presets. Writes params/logs/outputs, then QA-verifies every produced STL.',
    parameters: {
      family: { type: 'string', description: 'Family id, e.g. fcc-cell, channel-spheres, packing, cad-porous.' },
      preset: { type: 'string', description: 'Preset name from the family list (default: family default preset).' },
      name: { type: 'string', description: 'Output base name; default from the preset. Overwriting an existing name is allowed.' },
      outDir: { type: 'string', description: 'Output directory (relative to the project root or absolute inside it). Default: <workRoot>/<family>.' },
      params: { type: 'object', additionalProperties: true, description: 'Overrides merged INTO the preset JSON (deep merge) — e.g. {"sphere_radius_mm": 2.45}.' },
      dryRun: { type: 'boolean', description: 'Only resolve paths and commands; do not execute.' },
    },
    async execute(args, config) {
      const blocked = requireProject(config)
      if (blocked) return blocked
      if (!args.family) {
        return {
          configured: true,
          families: catalogFamilies(registry, config),
          dataFile: 'data/generators.json',
          next: 'stl_generate({ family: "<id>", preset: "<name>", name: "geom-1" })',
        }
      }
      const family = registry.families.find((f) => f.id === args.family)
      if (!family) {
        return {
          error: `unknown family: ${args.family}`,
          families: registry.families.map((f) => f.id),
        }
      }
      try {
        return await runFamily(config, family, args)
      } catch (error) {
        return { error: error.message, family: family.id }
      }
    },
  })

  register({
    name: 'stl_check',
    description: 'STL QA and passport: watertight/winding/bodies/volume/area/bbox, optional cleanup, '
      + 'optional append to stl/registry.csv. QA runs in-process on JS (lib/qa/); engine:"python" uses '
      + 'tools/qa/stl_qa.py as the reference implementation. Never meshes anything.',
    parameters: {
      stl: { type: 'string', description: 'STL path (relative to the project root or absolute). Required.' },
      cleanup: { type: 'boolean', description: 'Also write a cleaned STL (vertex merge, drop degenerate/duplicate faces).' },
      cleanOut: { type: 'string', description: 'Cleaned STL path; default <stl dir>/<stem>.clean.stl.' },
      expectVolume: { type: 'number', description: 'Expected volume, mm^3 (enables the volume check).' },
      expectArea: { type: 'number', description: 'Expected surface area, mm^2.' },
      expectBodies: { type: 'number', description: 'Expected number of closed shells (1 + enclosed voids: a block with 27 internal spheres has 28). Omit to skip — the count depends on the geometry.' },
      maxVolumeErr: { type: 'number', description: 'Volume tolerance in PERCENT (1 = 1 %; 0.01 = 0.01 %).' },
      maxAreaErr: { type: 'number', description: 'Area tolerance in PERCENT (1 = 1 %).' },
      register: { type: 'boolean', description: 'Append a passport row to stl/registry.csv.' },
      family: { type: 'string', description: 'Registry family label (default "plugin").' },
      generator: { type: 'string', description: 'Registry generator/script label.' },
      paramsFile: { type: 'string', description: 'Registry params file reference.' },
      fluidOrSolid: { type: 'string', description: 'Registry fluid_or_solid value (default "solid").' },
      notes: { type: 'string', description: 'Registry notes.' },
      engine: { type: 'string', enum: ['js', 'python'], description: "QA engine: 'js' (default, in-process) or 'python' (tools/qa/stl_qa.py, parity reference)." },
    },
    async execute(args, config) {
      const blocked = requireProject(config)
      if (blocked) return blocked
      if (!args.stl) return { error: 'stl is required' }
      const stlPath = resolveProjectPath(config, args.stl)
      if (!existsSync(stlPath)) return { error: `STL not found: ${stlPath}` }
      const info = statSync(stlPath)
      if (info.isDirectory()) return { error: `expected an STL file, got a directory: ${stlPath}` }

      const cleanOut = args.cleanup
        ? resolveProjectPath(config, args.cleanOut || join(dirname(stlPath), `${stem(stlPath)}.clean.stl`))
        : undefined
      if (cleanOut && !cleanOut.toLowerCase().endsWith('.stl')) {
        return { error: `cleanOut must end with .stl: ${cleanOut}` }
      }
      if (cleanOut) mkdirSync(dirname(cleanOut), { recursive: true })

      const qa = qaFile(config, stlPath, {
        cleanOut,
        expectVolume: args.expectVolume,
        expectArea: args.expectArea,
        expectBodies: args.expectBodies,
        maxVolumeErr: args.maxVolumeErr,
        maxAreaErr: args.maxAreaErr,
        engine: args.engine,
      })
      if (qa.error) return { error: qa.error, file: displayPath(config, stlPath), qa }
      if (args.maxVolumeErr != null && args.maxVolumeErr > 0 && args.maxVolumeErr <= 0.05) {
        qa.warnings = [...(qa.warnings ?? []), 'maxVolumeErr is a PERCENT value: 0.01 means 0.01 %, not 1 % — pass 1 for a 1 % tolerance']
      }

      let registered = null
      if (args.register) {
        const values = {
          geom_id: stem(args.cleanOut || stlPath),
          name: stem(args.cleanOut || stlPath),
          family: args.family ?? 'plugin',
          generator: args.generator ?? 'mesh-stl',
          params_file: args.paramsFile ?? '',
          seed: '',
          units: 'mm',
          domain_mm: formatBbox(qa.bboxMm),
          periodic: 'no',
          fluid_or_solid: args.fluidOrSolid ?? 'solid',
          triangles: qa.triangles,
          area_mm2: qa.areaMm2,
          volume_mm3: qa.volumeMm3,
          bbox_mm: formatBbox(qa.bboxMm),
          watertight: qa.watertight,
          date: new Date().toISOString().slice(0, 10),
          path: displayPath(config, cleanOut || stlPath),
          notes: args.notes ?? '',
        }
        try {
          registered = { ok: true, ...appendRegistryRow(config, values), row: values }
        } catch (error) {
          // A read-only or foreign registry must not turn a QA verdict into a tool error: the
          // surface is still checked, the row just was not written (plan 1.3).
          registered = { ok: false, file: registryFilePath(config), error: String(error.message ?? error), row: values }
        }
      }

      return {
        configured: true,
        file: displayPath(config, stlPath),
        bytes: info.size,
        qa,
        cleanedFile: cleanOut ? displayPath(config, cleanOut) : undefined,
        // the cleaned file carries the same surface: report what cleanup changed, do not re-judge it
        cleaned: cleanOut ? { file: displayPath(config, cleanOut), cleanup: qa.clean ?? null } : undefined,
        registered,
        verdict: qa.verdict,
        next: [
          ...(registered && registered.ok === false
            ? [`registry not written (${registered.error}); the row is in registered.row — fix the registry path (config registry / MESH_STL_REGISTRY) or pass register:false`]
            : []),
          ...(qa.verdict === 'PASS'
            ? ['mesh_build({ route: "snappy", scaffold: true, caseDir: "...", stl: ["' + displayPath(config, cleanOut || stlPath) + '"], scaffoldOptions: { domainMin, domainMax, cellSize, locationInMesh } }) — or scaffold:false for an existing case']
            : [
                'cleanup:true — write cleaned STL and re-check it',
                'stl_hints({ id: "stl-cleanup" }) for what cleaning fixes',
              ]),
        ],
      }
    },
  })

  // Capability seam: other Sim plugins call these handlers instead of importing this
  // package's files or reading its hints by relative path.
  provideService(ctx, 'simGeometry', {
    version: CAPABILITIES.simGeometry,
    owner: name,
    capabilities: ['hints', 'generate', 'qa'],
    invoke: (tool, args, exec) => {
      const handler = handlers[tool]
      if (!handler) throw new Error(`simGeometry: unknown tool "${tool}"`)
      return handler(args, exec)
    },
    hints: (args, exec) => handlers.stl_hints(args, exec),
    generate: (args, exec) => handlers.stl_generate(args, exec),
    qa: (args, exec) => handlers.stl_check(args, exec),
  })
}
