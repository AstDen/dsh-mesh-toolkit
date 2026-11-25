/**
 * mesh-stl/lib/generators.js — data-driven generator registry.
 *
 * data/generators.json declares which project scripts exist, how to call them,
 * which parameters they take and which STL files they produce. Adding a
 * generator = adding an entry (plus its script in the project). No code change.
 * @module mesh-stl/lib/generators
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  displayPath, jsonSafe, q, readJson, resolveProjectPath, runPython, slugify, stem, tail,
} from './common.js'
import { buildPrimitive } from './primitives.js'

/** Load the registry and validate the minimum shape. */
export function loadRegistry(dataDir) {
  const file = join(dataDir, 'generators.json')
  const raw = readJson(file, 'generators.json')
  const families = Array.isArray(raw.families) ? raw.families : []
  for (const family of families) {
    const internal = family.engine === 'primitive'
    if (!family.id || !family.script || !Array.isArray(family.steps) || (!internal && family.steps.length === 0)) {
      throw new Error(`generators.json: family ${family.id ?? '<without id>'} needs id, script, steps[] (empty steps are allowed only for engine "primitive")`)
    }
  }
  return { version: raw.version ?? 1, families, file }
}

/** Public catalog (no long internals). */
export function catalogFamilies(registry, config) {
  return registry.families.map((family) => {
    const presets = listPresets(family, config)
    return {
      id: family.id,
      title: family.title,
      description: family.description ?? null,
      script: family.script,
      presetDir: family.preset?.dir ?? null,
      defaultPreset: family.preset?.default ?? null,
      presets: presets.map((p) => p.name),
      outputs: (family.outputs ?? []).map((entry) => (typeof entry === 'string' ? entry : entry.role)),
      notes: family.notes ?? null,
    }
  })
}

/** Available presets for a family (optionally filtered by preset.include globs). */
export function listPresets(family, config) {
  const dir = presetDirectory(config, family)
  if (!dir || !existsSync(dir)) return []
  const ext = family.preset?.ext ?? '.json'
  const include = Array.isArray(family.preset?.include) ? family.preset.include : ['*.json']
  const patterns = include.map((glob) => new RegExp(`^${String(glob).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`))
  return readdirSync(dir)
    .filter((file) => extname(file).toLowerCase() === ext.toLowerCase())
    .filter((file) => patterns.some((re) => re.test(file)))
    .sort()
    .map((file) => ({
      name: stem(file),
      file: join(dir, file),
      default: basename(file) === family.preset?.default,
    }))
}

function deepMerge(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {}
  for (const [key, value] of Object.entries(patch)) {
    out[key] = deepMerge(out[key], value)
  }
  return out
}

/** Resolve a preset name/path into an absolute JSON file (or null). */
export function resolvePreset(family, preset, config) {
  if (!preset) {
    const def = family.preset?.default
    if (!def) return null
    return join(presetDirectory(config, family), def)
  }
  const asPath = resolveProjectPath(config, preset)
  if (existsSync(asPath)) return asPath
  const byName = listPresets(family, config).find((p) => p.name === String(preset).replace(/\.json$/i, ''))
  return byName ? byName.file : null
}

function render(template, ctx) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    if (!(key in ctx)) throw new Error(`unknown generator placeholder {${key}}`)
    return String(ctx[key])
  })
}

function isInside(root, target) {
  const rel = relative(resolve(root), resolve(target))
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..')
}

/** Build the command context (all placeholder values) for a run. */
export function buildContext(family, config, args) {
  const requested = args.outDir
  const workRoot = resolveProjectPath(config, config.workRoot)
  const outDir = requested
    ? (isAbsolute(String(requested)) ? resolve(String(requested)) : resolve(config.projectRoot, String(requested)))
    : join(workRoot, family.id)
  if (!isInside(config.projectRoot, outDir)) {
    throw new Error(`outDir must stay inside the project root ${config.projectRoot}: ${outDir}`)
  }
  const presetFile = args.paramsFile
    ? resolveProjectPath(config, args.paramsFile)
    : resolvePreset(family, args.preset, config)
  const name = slugify(args.name || (presetFile ? stem(presetFile) : `${family.id}-${Date.now()}`), family.id)
  const paramsDir = presetDirectory(config, family) || config.projectRoot
  if (presetFile && !existsSync(presetFile)) {
    const available = listPresets(family, config).map((p) => p.name).join(', ') || '(none)'
    throw new Error(`preset not found: ${args.preset ?? presetFile}\navailable presets: ${available}`)
  }
  const paramsFile = join(outDir, `${name}.params.json`)
  const script = resolveScript(config, family.script)
  const ctx = {
    script: script.file,
    scriptResolvedFrom: script.resolvedFrom,
    paramsDir,
    presetFile: presetFile ?? '',
    paramsFile,
    outDir,
    name,
    json: join(outDir, `${name}.generator.json`),
    rawOut: join(outDir, `${name}.raw.stl`),
    cleanOut: join(outDir, `${name}.stl`),
    solidRawOut: join(outDir, `${name}.solid.raw.stl`),
    solidOut: join(outDir, `${name}.solid.stl`),
    fluidRawOut: join(outDir, `${name}.fluid.raw.stl`),
    fluidOut: join(outDir, `${name}.fluid.stl`),
    fluidPatchesOut: join(outDir, `${name}.fluid_patches.stl`),
    ballsCsv: join(outDir, `${name}.balls.csv`),
    contactsCsv: join(outDir, `${name}.contacts.csv`),
    packingJson: join(outDir, `${name}.packing.json`),
  }
  return { ctx, outDir, name, presetFile, paramsFile }
}

/** Preset directory: `@package/...` comes from this bundle, everything else from the project. */
function presetDirectory(config, family) {
  const dir = family.preset?.dir
  if (!dir) return ''
  if (String(dir).startsWith('@package/')) return join(config.packageRoot, String(dir).slice('@package/'.length))
  return resolveProjectPath(config, dir)
}

/**
 * Resolve a generator script: absolute, project-relative, or one of
 * `geometry.scriptRoots` from sim-project.json (shared/portable generator trees).
 */
export function resolveScript(config, script) {
  const raw = String(script ?? '')
  if (!raw) return { file: '', resolvedFrom: null }
  if (isAbsolute(raw)) return { file: raw, resolvedFrom: 'absolute' }
  const roots = [config.projectRoot, ...(config.geometry?.scriptRoots ?? [])].filter(Boolean)
  for (const root of roots) {
    const file = resolve(root, raw)
    if (existsSync(file)) {
      return { file, resolvedFrom: root === config.projectRoot ? 'project' : root }
    }
  }
  return {
    file: resolve(config.projectRoot ?? config.geometry?.base ?? process.cwd(), raw),
    resolvedFrom: 'project',
    missing: true,
  }
}

/** Write the params file: preset copy, or preset + user overrides. */
export function prepareParams(config, family, ctx, presetFile, overrides) {
  mkdirSync(ctx.outDir, { recursive: true })
  if (overrides && Object.keys(overrides).length) {
    const base = presetFile ? readJson(presetFile, presetFile) : {}
    const merged = deepMerge(base, overrides)
    writeFileSync(ctx.paramsFile, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    return { mode: 'merged', file: ctx.paramsFile, base: presetFile }
  }
  if (presetFile) {
    copyFileSync(presetFile, ctx.paramsFile)
    return { mode: 'copied', file: ctx.paramsFile, base: presetFile }
  }
  // No preset at all: let the generator apply its own defaults.
  return { mode: 'defaults', file: presetFile ?? '', base: null }
}

/** Build argv lists without executing anything (for dryRun and tests). */
export function planSteps(family, ctx) {
  const executable = ctx.script ?? family.script
  return family.steps.map((step, index) => ({
    index: index + 1,
    script: render(step.script ?? executable, ctx),
    args: (step.args ?? []).map((arg) => render(arg, ctx)),
    description: step.description ?? null,
  }))
}

/** Execute the family pipeline: steps -> outputs -> QA. */
export async function runFamily(config, family, args) {
  const { ctx, outDir, name, presetFile } = buildContext(family, config, args)
  const params = args.dryRun
    ? { mode: 'dry-run', file: ctx.paramsFile, base: presetFile ?? null }
    : prepareParams(config, family, ctx, presetFile, args.params)
  let steps = planSteps(family, ctx)
  if (family.engine === 'primitive') {
    steps = [{ index: 1, script: 'builtin:primitive', args: [], description: 'builtin STL primitive (no Python)' }]
  }
  const logDir = join(outDir, 'logs')
  if (!args.dryRun) mkdirSync(logDir, { recursive: true })

  const executed = []
  let failure = null
  for (const step of steps) {
    if (args.dryRun) {
      executed.push({ ...step, executed: false })
      continue
    }
    if (step.script === 'builtin:primitive') {
      const params = readJson(ctx.paramsFile, ctx.paramsFile)
      const info = buildPrimitive(params, ctx.cleanOut)
      writeFileSync(ctx.json, `${JSON.stringify({ ...info, generated_by: 'mesh-stl/lib/primitives.js' }, null, 2)}\n`)
      writeFileSync(join(logDir, 'step-1.log'), `$ builtin primitive ${info.shape} -> ${ctx.cleanOut}\n`)
      executed.push({
        ...step, executed: true, code: 0, durationMs: 0,
        output: displayPath(config, ctx.cleanOut), triangles: info.triangles,
      })
      continue
    }
    const result = runPython(config, step.script, step.args, { cwd: config.projectRoot })
    const logFile = join(logDir, `step-${step.index}.log`)
    writeFileSync(logFile, `$ ${config.python} ${step.script} ${step.args.join(' ')}\n\n${result.stdout}\n${result.stderr}`, 'utf8')
    executed.push({
      ...step,
      executed: true,
      code: result.code,
      durationMs: result.durationMs,
      log: displayPath(config, logFile),
      stdoutTail: tail(result.stdout, 2000),
      stderrTail: tail(result.stderr, 2000),
    })
    if (result.code !== 0) {
      failure = {
        step: step.index,
        code: result.code,
        message: `generator step ${step.index} failed (exit ${result.code})`,
        log: displayPath(config, logFile),
        stderrTail: tail(result.stderr, 4000),
      }
      break
    }
  }

  const declared = (family.outputs ?? []).map((entry) => (
    typeof entry === 'string' ? { role: basename(entry, extname(entry)), path: render(entry, ctx) } : {
      role: entry.role,
      path: render(entry.path, ctx),
      required: entry.required !== false,
      qa: entry.qa !== false,
    }
  ))
  // the generator report is read first: it declares how many closed shells each output must have
  let generatorReport = null
  if (existsSync(ctx.json)) {
    try { generatorReport = readJson(ctx.json, ctx.json) } catch (error) { generatorReport = { error: error.message } }
  }

  const files = []
  const missing = []
  for (const entry of declared) {
    if (!existsSync(entry.path)) {
      if (entry.required !== false) missing.push(entry.path)
      continue
    }
    const fileInfo = { role: entry.role, path: entry.path, display: displayPath(config, entry.path), bytes: statSync(entry.path).size }
    if (!args.dryRun && entry.qa !== false) {
      fileInfo.qa = qaFile(config, entry.path, { expectBodies: declaredBodies(generatorReport, entry.role) })
    }
    files.push(fileInfo)
  }

  const plannedPrimary = declared.find((d) => d.role === 'solid')
    ?? declared.find((d) => d.qa)
    ?? declared[0]
  const primaryFile = files.find((f) => f.role === 'solid')
    ?? files.find((f) => f.qa)
    ?? files[0]
    ?? (plannedPrimary ? { path: plannedPrimary.path } : null)
  return {
    configured: true,
    dryRun: Boolean(args.dryRun),
    family: family.id,
    title: family.title,
    name,
    outDir,
    outDirDisplay: displayPath(config, outDir),
    params,
    commands: steps.map((s) => (s.script === 'builtin:primitive'
      ? 'builtin: primitive STL (mesh-stl/lib/primitives.js)'
      : `${config.python} ${s.script} ${s.args.join(' ')}`)),
    steps: executed,
    files,
    missingOutputs: missing,
    generatorReport,
    failure,
    next: failure
      ? ['read the step log, fix the input params, call stl_generate again with the same name']
      : [
          `stl_check({ stl: "${displayPath(config, primaryFile?.path ?? join(outDir, `${name}.stl`))}", cleanup: true, register: true }) to re-verify and register`,
          'mesh_build({ route: "snappy", scaffold: true, caseDir: "...", stl: [...], scaffoldOptions: {...} }) to turn the STL into a volume mesh (scaffold:false for an existing case)',
        ],
  }
}

/** Closed-shell count the generator report declares for one output role (undefined = not declared). */
export function declaredBodies(report, role) {
  if (!report || typeof report !== 'object') return undefined
  const pick = (value) => (Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : undefined)
  if (role === 'fluid') return pick(report.fluid_out?.n_bodies ?? report.fluid_n_bodies)
  return pick(report.n_bodies ?? report.expected_bodies)
}

/** Run stl_qa.py on a single file and return its JSON. */
export function qaFile(config, file, options = {}) {
  const qaScript = join(config.projectRoot, 'tools', 'qa', 'stl_qa.py')
  if (!existsSync(qaScript)) return { error: `stl_qa.py not found: ${qaScript}` }
  const jsonFile = join(tmpdir(), `mesh-stl-qa-${process.pid}-${Date.now()}.json`)
  mkdirSync(tmpdir(), { recursive: true })
  const args = ['--stl', file, '--json', jsonFile]
  if (options.cleanOut) args.push('--clean-out', options.cleanOut)
  if (options.expectVolume != null) args.push('--expect-volume', String(options.expectVolume))
  if (options.expectArea != null) args.push('--expect-area', String(options.expectArea))
  if (options.expectBodies != null) args.push('--expect-bodies', String(options.expectBodies))
  if (options.maxVolumeErr != null) args.push('--max-volume-err', String(options.maxVolumeErr))
  if (options.maxAreaErr != null) args.push('--max-area-err', String(options.maxAreaErr))
  const result = runPython(config, qaScript, args, { cwd: config.projectRoot })
  let report = null
  try { report = readJson(jsonFile, jsonFile) } catch { /* leave null */ }
  try { unlinkSyncSafe(jsonFile) } catch { /* ignore */ }
  if (!report) {
    return {
      error: 'stl_qa.py produced no JSON',
      code: result.code,
      stdoutTail: tail(result.stdout, 3000),
      stderrTail: tail(result.stderr, 3000),
    }
  }
  return {
    verdict: report.verdict ?? null,
    problems: report.qa_problems ?? [],
    warnings: report.warnings ?? [],
    expectedBodies: report.expected_bodies ?? null,
    watertight: report.cleaned?.is_watertight ?? report.is_watertight ?? null,
    windingConsistent: report.cleaned?.is_winding_consistent ?? report.is_winding_consistent ?? null,
    triangles: report.cleaned?.triangles ?? report.triangles ?? null,
    bodies: report.cleaned?.bodies ?? report.bodies ?? null,
    volumeMm3: report.cleaned?.volume ?? report.volume ?? null,
    areaMm2: report.cleaned?.area ?? report.area ?? null,
    bboxMm: report.bbox_size ?? null,
    degenerateFaces: report.degenerate_faces ?? null,
    clean: report.clean ?? null,
    raw: options.includeRaw ? report : undefined,
  }
}

function unlinkSyncSafe(file) {
  try { unlinkSync(file) } catch { /* ignore */ }
}
