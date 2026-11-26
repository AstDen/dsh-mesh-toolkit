/**
 * mesh-stl/lib/common.js — thin facade over sim-core.
 *
 * All shared mechanics (config layering, profile discovery, process runner, JSON
 * safety, path resolution) live in `../sim-core`. This file only supplies the
 * package-specific defaults and keeps the helper names the plugin code already uses.
 * @module mesh-stl/lib/common
 */
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveConfig, missingProfilePayload } from '../../sim-core/lib/config.js'
import { versionInfo as coreVersionInfo, readPackageVersion } from '../../sim-core/lib/env.js'
import { resolvePath } from '../../sim-core/lib/paths.js'
import { executionCwd, q, runBash, runPython } from '../../sim-core/lib/process.js'
import {
  csvField, displayPath, expandStlFiles, jsonSafe, readJson, slugify, stem, tail,
} from '../../sim-core/lib/util.js'

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const PKG_VERSION = readPackageVersion(PACKAGE_ROOT)

/** Package defaults; overridable by bundle config, external config and env. */
export const DEFAULTS = {
  projectRoot: '',
  python: '',
  openfoamBashrc: '',
  openfoamRoots: [],
  workRoot: 'stl/generated',
  registry: 'stl/registry.csv',
  timeoutMs: 1800000,
  maxOutputChars: 20000,
  qaEngine: 'js',
}

/** Env names keep the pre-0.3 spelling (`MESH_STL_PROJECT_ROOT`, ...). */
const ENV_ALIASES = {
  projectRoot: 'PROJECT_ROOT',
  python: 'PYTHON',
  openfoamBashrc: 'OPENFOAM_BASHRC',
  openfoamRoots: 'OPENFOAM_ROOTS',
  workRoot: 'WORK_ROOT',
  registry: 'REGISTRY',
  timeoutMs: 'TIMEOUT_MS',
  maxOutputChars: 'MAX_OUTPUT_CHARS',
  qaEngine: 'QA_ENGINE',
}

/** Resolve config for one call; `starts` are cwd candidates from the agent session. */
export function normalizeConfig(raw = {}, starts = []) {
  const config = resolveConfig({
    raw,
    defaults: DEFAULTS,
    envPrefix: 'MESH_STL',
    packageName: 'mesh-stl',
    packageRoot: PACKAGE_ROOT,
    starts,
    envAliases: ENV_ALIASES,
    profilePaths: (profile) => ({
      workRoot: profile.geometry?.workRoot || DEFAULTS.workRoot,
      registry: profile.geometry?.registry || DEFAULTS.registry,
    }),
  })
  const base = config.projectRoot || config.rootDir || process.cwd()
  const scriptRoots = (config.geometry?.scriptRoots ?? [])
    .map((root) => resolve(String(root)))
    .filter(Boolean)
  return {
    ...config,
    packageRoot: PACKAGE_ROOT,
    version: PKG_VERSION,
    geometry: { ...(config.geometry ?? {}), scriptRoots, base },
    qa: { engine: String(config.qaEngine ?? config.qa?.engine ?? 'js').toLowerCase() },
  }
}

/** Payload for tools that need a project profile (kept as a distinct failure mode). */
export function unconfiguredPayload(config) {
  return {
    ...missingProfilePayload(config),
    hint: 'Create sim-project.json at the project root (see sim-core/schemas), '
      + 'set MESH_STL_PROJECT_ROOT, or pass absolute paths — STL tools also work without a profile.',
  }
}

/** Package version on disk vs the loaded one. */
export function versionInfo() {
  return coreVersionInfo(PACKAGE_ROOT, PKG_VERSION)
}

/** Resolve a user path: absolute, else from the project root (or the cwd without a profile). */
export function resolveProjectPath(config, p) {
  if (!p) return ''
  const hit = resolvePath(String(p), {
    cwd: config.rootDir || process.cwd(),
    projectRoot: config.projectRoot,
    caseRootPaths: config.caseRootPaths,
  })
  return hit.dir
}

/** Expand a file, directory, array or simple pattern into STL files. */
export function expandStlInputs(config, input) {
  return expandStlFiles(input, (raw) => resolveProjectPath(config, raw))
}

export {
  csvField, displayPath, executionCwd, jsonSafe, q, readJson, runBash, runPython, slugify, stem, tail,
}
