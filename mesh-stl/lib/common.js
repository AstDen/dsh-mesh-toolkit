/**
 * mesh-stl/lib/common.js — configuration, path resolution, process execution,
 * JSON helpers. No project-specific knowledge here: everything comes from
 * data/generators.json and data/hints/*.json.
 *
 * Priority: DEFAULTS -> bundle config -> external config.json -> environment.
 * @module mesh-stl/lib/common
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

let cachedVersion = '0.0.0'
try {
  cachedVersion = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')).version ?? cachedVersion
} catch { /* keep fallback */ }
export const PKG_VERSION = cachedVersion

/** Path to the user's external config. */
export function externalConfigPath() {
  if (process.env.MESH_STL_CONFIG) return resolve(process.env.MESH_STL_CONFIG)
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, 'mesh-stl', 'config.json')
}

/** Portable defaults; nothing machine-specific. */
export const DEFAULTS = {
  /** Project root; empty = auto-detect from the agent cwd. */
  projectRoot: '',
  /** Python interpreter; empty = <root>/.venv/bin/python then python3. */
  python: '',
  /** OpenFOAM environment file (needed by QA/registry helpers). */
  openfoamBashrc: '',
  /** Extra roots to search for OpenFOAM installations (e.g. "/opt/OpenFOAM"); empty = common system roots. */
  openfoamRoots: [],
  /** Scratch output root for stl_generate (relative to the project root). */
  workRoot: 'stl/generated',
  /** STL passport registry (relative to the project root). */
  registry: 'stl/registry.csv',
  /** Timeout of one generator/QA process, ms. */
  timeoutMs: 1800000,
  /** Cap for a tool response, characters (full logs stay on disk). */
  maxOutputChars: 20000,
}

function readExternalConfig() {
  const file = externalConfigPath()
  if (!existsSync(file)) return { config: {}, path: null }
  try {
    const config = JSON.parse(readFileSync(file, 'utf8'))
    if (config === null || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('a JSON object is expected')
    }
    return { config, path: file }
  } catch (error) {
    throw new Error(`external config ${file}: ${error.message}`)
  }
}

function envConfig() {
  const out = {}
  const map = {
    MESH_STL_PROJECT_ROOT: 'projectRoot',
    MESH_STL_PYTHON: 'python',
    MESH_STL_OPENFOAM_BASHRC: 'openfoamBashrc',
    MESH_STL_OPENFOAM_ROOTS: 'openfoamRoots',
    MESH_STL_WORK_ROOT: 'workRoot',
    MESH_STL_REGISTRY: 'registry',
  }
  for (const [env, key] of Object.entries(map)) {
    if (process.env[env]) out[key] = process.env[env]
  }
  if (process.env.MESH_STL_TIMEOUT_MS) out.timeoutMs = Number(process.env.MESH_STL_TIMEOUT_MS)
  return out
}

/** Is this a pore-scale project root we understand? */
export function looksLikeProject(dir) {
  if (!dir || !existsSync(dir)) return false
  return existsSync(join(dir, 'tools', 'qa', 'stl_qa.py'))
    && existsSync(join(dir, 'geometry'))
}

/** Walk up from start to find the project root. */
export function detectProjectRoot(start = process.cwd()) {
  let dir = resolve(start)
  for (let i = 0; i < 8; i += 1) {
    if (looksLikeProject(dir)) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return ''
}

/** Candidate start directories from a tool execution (the agent session cwd). */
export function executionCwd(exec) {
  const starts = []
  try {
    const cwd = exec?.agent?.session?.header?.cwd
    if (typeof cwd === 'string' && cwd) starts.push(cwd)
  } catch { /* agent is optional */ }
  try {
    const cwd = exec?.agent?.cwd
    if (typeof cwd === 'string' && cwd) starts.push(cwd)
  } catch { /* ignore */ }
  return starts
}

function detectOpenFoamBashrc(extraRoots = []) {
  const candidates = []
  // Conventional system locations only; custom trees come from config/env (openfoamRoots).
  const roots = [...extraRoots, '/usr/lib/openfoam', '/opt/openfoam', join(homedir(), 'openfoam')]
  for (const root of roots) {
    if (!existsSync(root)) continue
    let entries = []
    try { entries = readdirSync(root) } catch { entries = [] }
    for (const entry of entries.sort().reverse()) {
      const candidate = join(root, entry, 'etc', 'bashrc')
      if (existsSync(candidate)) candidates.push(candidate)
    }
  }
  return candidates[0] ?? ''
}

function pickPython(projectRoot) {
  const venv = projectRoot ? join(projectRoot, '.venv', 'bin', 'python') : ''
  if (venv && existsSync(venv)) return venv
  const which = spawnSync('which', ['python3'], { encoding: 'utf8' })
  return which.status === 0 ? which.stdout.trim() : 'python3'
}

/**
 * Merge and resolve the configuration. Never throws for a missing project:
 * tools report `configured:false` and the connection hint instead.
 */
export function normalizeConfig(raw = {}, starts = []) {
  const external = readExternalConfig()
  const merged = { ...DEFAULTS, ...(raw ?? {}), ...external.config, ...envConfig() }
  const projectRoot = merged.projectRoot
    ? resolve(String(merged.projectRoot))
    : (() => {
        for (const start of [process.cwd(), ...starts]) {
          const found = detectProjectRoot(start)
          if (found) return found
        }
        return ''
      })()
  const configured = Boolean(projectRoot && looksLikeProject(projectRoot))
  const python = String(merged.python || pickPython(configured ? projectRoot : ''))
  const openfoamRoots = (Array.isArray(merged.openfoamRoots) ? merged.openfoamRoots : String(merged.openfoamRoots || '').split(':'))
    .map((root) => String(root).trim())
    .filter(Boolean)
    .map((root) => resolve(root))
  const openfoamBashrc = String(merged.openfoamBashrc || detectOpenFoamBashrc(openfoamRoots))
  const timeoutMs = Math.max(1000, Number(merged.timeoutMs) || DEFAULTS.timeoutMs)
  return {
    configured,
    projectRoot: configured ? projectRoot : '',
    requestedProjectRoot: merged.projectRoot ? resolve(String(merged.projectRoot)) : '',
    python,
    openfoamBashrc,
    openfoamRoots,
    workRoot: String(merged.workRoot || DEFAULTS.workRoot),
    registry: String(merged.registry || DEFAULTS.registry),
    timeoutMs,
    maxOutputChars: Math.max(2000, Number(merged.maxOutputChars) || DEFAULTS.maxOutputChars),
    externalConfig: external.path,
    packageRoot: PACKAGE_ROOT,
    version: PKG_VERSION,
  }
}

/** Standard "not configured" payload with actionable instructions. */
export function unconfiguredPayload(config) {
  return {
    configured: false,
    reason: config.requestedProjectRoot
      ? `project root ${config.requestedProjectRoot} does not look like the pore-scale project (tools/qa/stl_qa.py + geometry/ are required)`
      : 'pore-scale project root was not found (searched upward from the cwd for tools/qa/stl_qa.py + geometry/)',
    hint: 'Set MESH_STL_PROJECT_ROOT=/path/to/Mesh_3D_pore_scale, or put {"projectRoot": "..."} into '
      + `${externalConfigPath()}, or run the agent from inside the project directory.`,
    checked: {
      cwd: process.cwd(),
      python: config.python,
      openfoamBashrc: config.openfoamBashrc || null,
    },
  }
}

/** Shell-quote one argument. */
export function q(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/**
 * Run a bash command, optionally sourcing the OpenFOAM environment first.
 * Returns status/stdout/stderr/duration; never throws on a non-zero code.
 */
export function runBash(command, options = {}) {
  const {
    cwd = process.cwd(),
    timeoutMs = 600000,
    openfoamBashrc = '',
    env = {},
    maxBuffer = 64 * 1024 * 1024,
  } = options
  // NOTE: `set -u` before an OpenFOAM bashrc makes the script exit 127 silently,
  // so the environment is sourced first and nounset is enabled afterwards.
  const source = openfoamBashrc ? `source ${q(openfoamBashrc)} >/dev/null 2>&1; set -u; ` : 'set -u; '
  const started = Date.now()
  const result = spawnSync('bash', ['-c', `set -o pipefail; ${source}${command}`], {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer,
    env: { ...process.env, ...env },
  })
  return {
    code: result.status ?? (result.signal ? 124 : 1),
    signal: result.signal ?? null,
    timedOut: Boolean(result.error && result.error.code === 'ETIMEDOUT'),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    durationMs: Date.now() - started,
  }
}

/** Run the configured Python interpreter on a script with an argument list. */
export function runPython(config, script, args = [], options = {}) {
  const command = [config.python, script, ...args].map(q).join(' ')
  return runBash(command, {
    cwd: options.cwd ?? config.projectRoot,
    timeoutMs: options.timeoutMs ?? config.timeoutMs,
    openfoamBashrc: options.openfoamBashrc ?? '',
    env: options.env,
  })
}

/** Last N characters of a log tail. */
export function tail(text, max = 6000) {
  const value = String(text ?? '')
  return value.length <= max ? value : `…[${value.length - max} chars trimmed]…\n${value.slice(-max)}`
}

/** Read JSON with a readable error. */
export function readJson(file, what = file) {
  if (!existsSync(file)) throw new Error(`file not found: ${what}`)
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (error) {
    throw new Error(`invalid JSON in ${what}: ${error.message}`)
  }
}

/** Relative path when possible, absolute otherwise. */
export function displayPath(config, path) {
  if (!path) return null
  const abs = resolve(path)
  if (!config.projectRoot) return abs
  const rel = relative(config.projectRoot, abs)
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : abs
}

/** Resolve a user path: absolute or relative to the project root. */
export function resolveProjectPath(config, p) {
  if (!p) return ''
  return isAbsolute(String(p)) ? resolve(String(p)) : resolve(config.projectRoot, String(p))
}

/** Recursively drop undefined/NaN; the tool output schema is lossless JSON. */
export function jsonSafe(value) {
  if (value === undefined) return undefined
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  // -0 is finite but NOT lossless JSON (dsh snapshotJsonValue rejects Object.is(-0)),
  // and trimesh/gmsh metrics legitimately return -0 for bbox minima.
  if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null
  if (Array.isArray(value)) return value.map(jsonSafe).filter((v) => v !== undefined)
  if (typeof value === 'object') {
    const out = {}
    for (const [key, val] of Object.entries(value)) {
      const safe = jsonSafe(val)
      if (safe !== undefined) out[key] = safe
    }
    return out
  }
  return null
}

/** Expand a path, a directory, an array or a simple * pattern into STL files. */
export function expandStlInputs(config, input) {
  const inputs = Array.isArray(input) ? input : [input]
  const files = []
  const missing = []
  for (const raw of inputs) {
    if (!raw) continue
    const path = resolveProjectPath(config, raw)
    if (!existsSync(path)) { missing.push(path); continue }
    const st = statSync(path)
    if (st.isDirectory()) {
      for (const entry of readdirSync(path).sort()) {
        if (extname(entry).toLowerCase() === '.stl') files.push(join(path, entry))
      }
      continue
    }
    if (statSync(path).isFile() && extname(path).toLowerCase() === '.stl') { files.push(path); continue }
    missing.push(path)
  }
  return { files: [...new Set(files)], missing }
}

/** Minimal CSV field quoting. */
export function csvField(value) {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Normalize a name for file/registry ids. */
export function slugify(value, fallback = 'stl') {
  const out = String(value ?? '')
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
  return out || fallback
}

/** Base name without extension. */
export function stem(file) {
  return basename(file, extname(file))
}
