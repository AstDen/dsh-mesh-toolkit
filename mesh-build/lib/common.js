/**
 * mesh-build/lib/common.js — thin facade over sim-core.
 *
 * Shared mechanics live in `../sim-core`; this file supplies the mesh-build defaults
 * and keeps the helper names the plugin code already uses.
 * @module mesh-build/lib/common
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

/**
 * Version on disk, read at CALL time: a long-running DSH keeps the version it loaded at
 * start, so `PKG_VERSION` can lag behind package.json after an upgrade (DEF-08).
 */
export function diskVersion() {
  return readPackageVersion(PACKAGE_ROOT)
}

/** Package defaults; overridable by bundle config, external config and env. */
export const DEFAULTS = {
  projectRoot: '',
  python: '',
  openfoamBashrc: '',
  openfoamRoots: [],
  workRoot: '.cache/mesh-build',
  caseRoot: 'experiments',
  np: 1,
  timeoutMs: 1800000,
  maxOutputChars: 20000,
}

/** Env names keep the pre-0.3 spelling (`MESH_BUILD_WORK_ROOT`, ...). */
const ENV_ALIASES = {
  projectRoot: 'PROJECT_ROOT',
  python: 'PYTHON',
  openfoamBashrc: 'OPENFOAM_BASHRC',
  openfoamRoots: 'OPENFOAM_ROOTS',
  workRoot: 'WORK_ROOT',
  caseRoot: 'CASE_ROOT',
  caseRoots: 'CASE_ROOTS',
  np: 'NP',
  timeoutMs: 'TIMEOUT_MS',
  maxOutputChars: 'MAX_OUTPUT_CHARS',
}

/** Resolve config for one call; `starts` are cwd candidates from the agent session. */
export function normalizeConfig(raw = {}, starts = []) {
  const config = resolveConfig({
    raw,
    defaults: DEFAULTS,
    envPrefix: 'MESH_BUILD',
    packageName: 'mesh-build',
    packageRoot: PACKAGE_ROOT,
    starts,
    envAliases: ENV_ALIASES,
    profilePaths: (profile) => ({
      workRoot: profile.scratch || DEFAULTS.workRoot,
      scratch: profile.scratch || DEFAULTS.workRoot,
    }),
  })
  return {
    ...config,
    caseRoot: config.caseRoots[0] || DEFAULTS.caseRoot,
    packageRoot: PACKAGE_ROOT,
    version: PKG_VERSION,
  }
}

/** Payload for tools that need a project profile (kept as a distinct failure mode). */
export function unconfiguredPayload(config) {
  return {
    ...missingProfilePayload(config),
    hint: 'Create sim-project.json at the project root (see sim-core/schemas), '
      + 'set MESH_BUILD_PROJECT_ROOT, or pass absolute paths.',
  }
}

/** Package version on disk vs the loaded one. */
export function versionInfo() {
  return coreVersionInfo(PACKAGE_ROOT, PKG_VERSION)
}

/**
 * Resolve a case-related path: absolute, then cwd, then `caseRoots`, then the project root.
 * The returned string is the chosen directory; use `resolvePath` from sim-core when the
 * caller needs `resolvedFrom` for diagnostics.
 */
export function resolveProjectPath(config, p) {
  if (!p) return ''
  const hit = resolvePath(String(p), {
    cwd: config.cwd || process.cwd(),
    projectRoot: config.projectRoot,
    caseRootPaths: config.caseRootPaths,
  })
  return hit.dir
}

/** Resolve with provenance (`resolvedFrom`, `missing`, `hint`). */
export function resolveWithInfo(config, p) {
  return resolvePath(String(p ?? ''), {
    cwd: config.cwd || process.cwd(),
    projectRoot: config.projectRoot,
    caseRootPaths: config.caseRootPaths,
  })
}

/** Expand a file, directory, array or simple pattern into STL files. */
export function expandStlInputs(config, input) {
  return expandStlFiles(input, (raw) => resolveProjectPath(config, raw))
}

export {
  csvField, displayPath, executionCwd, jsonSafe, q, readJson, runBash, runPython, slugify, stem, tail,
}
