/**
 * sim-core/lib/config.js — layered configuration and project-profile discovery.
 *
 * Priority: DEFAULTS -> bundle config -> external config.json -> environment.
 * The project profile (`sim-project.json`) overrides project-facing defaults
 * (units, caseRoots, gate, artifact paths) but never machine paths such as
 * `python` or `openfoamBashrc`: those belong to the machine, not the research project.
 * @module sim-core/lib/config
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { detectOpenFoamBashrc, normalizeRoots, readPackageVersion } from './env.js'
import { detectProfile, normalizeProfile, profileForRoot } from './project.js'
import { pickPython } from './process.js'

/** Path to the user's external config (`<prefix>_CONFIG` or XDG). */
export function externalConfigPath(configName, envPrefix) {
  const override = process.env[`${envPrefix}_CONFIG`]
  if (override) return resolve(override)
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(base, configName, 'config.json')
}

function readExternalConfig(file) {
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

function envValue(envName, fallbackType) {
  const raw = process.env[envName]
  if (raw === undefined || raw === '') return undefined
  if (fallbackType === 'number') {
    const value = Number(raw)
    return Number.isFinite(value) ? value : undefined
  }
  if (Array.isArray(fallbackType)) return raw.split(':').map((entry) => entry.trim()).filter(Boolean)
  return raw
}

/** Build the machine-level configuration (bundle config + external file + env). */
function machineConfig({ raw, defaults, envAliases = {}, envPrefix, packageName }) {
  const external = readExternalConfig(externalConfigPath(packageName, envPrefix))
  const env = {}
  for (const [key, fallback] of Object.entries(defaults)) {
    const alias = envAliases[key] ?? key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()
    const value = envValue(`${envPrefix}_${alias}`, fallback)
    if (value !== undefined) env[key] = value
  }
  return {
    merged: { ...defaults, ...(raw ?? {}), ...external.config, ...env },
    externalPath: external.path,
  }
}

/**
 * Resolve the effective configuration for one tool call.
 *
 * @param {object} options
 * @param {object} options.raw bundle config (from cordis.patch.yml)
 * @param {object} options.defaults package DEFAULTS
 * @param {string} options.envPrefix e.g. MESH_BUILD
 * @param {string} options.packageName e.g. mesh-build (external config dir)
 * @param {string} options.packageRoot
 * @param {string[]} [options.starts] candidate cwd values (agent session cwd)
 * @param {(profile: object|null) => {workRoot?: string}} [options.profilePaths]
 */
export function resolveConfig(options) {
  const {
    raw = {},
    defaults = {},
    envPrefix = 'SIM',
    packageName = 'sim',
    packageRoot = '',
    starts = [],
    profilePaths = () => ({}),
  } = options

  const { merged, externalPath } = machineConfig({
    raw, defaults, envAliases: options.envAliases, envPrefix, packageName,
  })

  // 1. explicit project root -> profile next to it
  const requestedRoot = merged.projectRoot ? resolve(String(merged.projectRoot)) : ''
  let profile = null
  let projectRoot = requestedRoot
  if (requestedRoot) {
    profile = profileForRoot(requestedRoot)
  } else {
    for (const start of [process.cwd(), ...starts]) {
      const found = detectProfile(start)
      if (found) {
        projectRoot = found.root
        profile = { root: found.root, file: found.file, profile: found.profile }
        break
      }
    }
  }
  const found = profile ? profile.profile : normalizeProfile({}, '', '')
  const rootDir = projectRoot || process.cwd()
  const profileExtra = profilePaths(found)
  const cwd = starts[0] || process.cwd()

  const configuredRoots = merged.openfoamRoots
  const openfoamRoots = normalizeRoots(
    (Array.isArray(configuredRoots) ? configuredRoots.length > 0 : Boolean(configuredRoots))
      ? configuredRoots
      : (found.foam?.roots ?? []),
  )
  const openfoamBashrc = String(
    merged.openfoamBashrc
      || found.foam?.bashrc
      || detectOpenFoamBashrc([...openfoamRoots, ...(found.foam?.root ? [found.foam.root] : [])]),
  )
  const caseRoots = (() => {
    if (Array.isArray(merged.caseRoots) && merged.caseRoots.length) return merged.caseRoots.map(String)
    if (merged.caseRoot) return [String(merged.caseRoot)]
    return found.caseRoots ?? []
  })()
  const caseRootPaths = caseRoots.map((entry) => (isAbsolute(entry) ? resolve(entry) : resolve(rootDir, entry)))
  const workRoot = String(profileExtra.workRoot || merged.workRoot || defaults.workRoot || '.cache/sim')
  const gate = {
    engine: String(merged.gateEngine || found.gate?.engine || 'js'),
    profile: String(merged.gateProfile || found.gate?.profile || 'gate'),
    profiles: found.gate?.profiles ?? {},
    minVol: merged.minVol !== undefined && merged.minVol !== null && merged.minVol !== ''
      ? Number(merged.minVol)
      : (found.gate?.minVol ?? null),
    script: String(merged.gateScript || found.gate?.script || ''),
  }
  const python = String(merged.python || pickPython(projectRoot))
  const timeoutMs = Math.max(1000, Number(merged.timeoutMs) || 1800000)
  const maxOutputChars = Math.max(2000, Number(merged.maxOutputChars) || 20000)
  const version = readPackageVersion(packageRoot)

  return {
    // identity
    packageRoot,
    packageName,
    version,
    envPrefix,
    // project
    configured: Boolean(profile),
    profileFound: Boolean(profile),
    profileFile: profile?.file ?? null,
    projectRoot,
    requestedProjectRoot: requestedRoot,
    rootDir,
    cwd,
    profileInfo: found,
    // project data
    units: String(found.units ?? 'mm'),
    caseRoots,
    caseRootPaths,
    scratch: String(profileExtra.scratch || found.scratch || ''),
    gate,
    geometry: found.geometry ?? {},
    cores: found.cores ?? {},
    // machine
    python,
    openfoamBashrc,
    openfoamRoots,
    workRoot,
    registry: String(profileExtra.registry || merged.registry || found.geometry?.registry || 'stl/registry.csv'),
    np: Math.max(1, Math.floor(Number(merged.np) || 1)),
    timeoutMs,
    maxOutputChars,
    externalConfig: externalPath,
    // raw machine values (diagnostics)
    machine: merged,
  }
}

/** Payload returned when a tool needs a project but there is none. */
export function missingProfilePayload(config) {
  return {
    configured: false,
    reason: 'sim-project.json was not found upward from the cwd, and no projectRoot was configured',
    hint: 'Create sim-project.json at the project root, set MESH_*_PROJECT_ROOT, or pass absolute paths. '
      + 'Tools still work without a profile: paths resolve from the cwd.',
    checked: { cwd: config.cwd, externalConfig: config.externalConfig },
  }
}
