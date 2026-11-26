/**
 * sim-core/lib/project.js — the `sim-project.json` profile.
 *
 * The profile is the only place that knows about a particular research project:
 * units, case roots, quality profiles, artifact locations. Plugins must work
 * without it (case-local mode) — the profile only makes defaults project-aware.
 * @module sim-core/lib/project
 */
import { existsSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { readJson } from './util.js'

export const PROFILE_FILE = 'sim-project.json'

/** Built-in quality profiles (percent degrees / fractions; minVol stays absolute). */
export const BUILTIN_GATE_PROFILES = {
  gate: {
    maxNonOrtho: 65, maxInternalSkewness: 4, maxBoundarySkewness: 20,
    minFaceWeight: 0.05, minVolRatio: 0.01, minDeterminant: 0.001,
  },
  project: {
    maxNonOrtho: 60, maxInternalSkewness: 2, maxBoundarySkewness: 4,
    minFaceWeight: 0.1, minVolRatio: 0.05, minDeterminant: 0.001,
  },
  relaxed: {
    maxNonOrtho: 75, maxInternalSkewness: 4, maxBoundarySkewness: 20,
    minFaceWeight: 0.05, minVolRatio: 0.01, minDeterminant: 0.001,
  },
}

const DEFAULTS = {
  units: 'mm',
  // Case-local default: a bare directory keeps its meshes under ./cases. A profile
  // overrides this with its own roots (the research project uses experiments/ and cases/).
  caseRoots: ['./cases'],
  scratch: '',
  foam: {},
  gate: {},
  geometry: {},
  cores: {},
}

/** Read and validate a profile file. */
export function readProfile(root, file = join(root, PROFILE_FILE)) {
  const data = readJson(file, file)
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`${file}: expected a JSON object`)
  }
  return normalizeProfile(data, root, file)
}

/** Merge a raw profile with the portable defaults; roots become absolute paths. */
export function normalizeProfile(raw = {}, root = '', file = '') {
  const gate = { ...DEFAULTS.gate, ...(raw.gate ?? {}) }
  const profiles = { ...BUILTIN_GATE_PROFILES, ...(gate.profiles ?? {}) }
  const caseRoots = Array.isArray(raw.caseRoots) && raw.caseRoots.length
    ? raw.caseRoots.map(String)
    : [...DEFAULTS.caseRoots]
  return {
    file,
    project: raw.project ? String(raw.project) : (root ? basename(resolve(root)) : null),
    root,
    units: String(raw.units ?? DEFAULTS.units),
    caseRoots,
    caseRootPaths: caseRoots.map((entry) => (isAbsolute(entry) ? resolve(entry) : resolve(root || process.cwd(), entry))),
    scratch: raw.scratch ? String(raw.scratch) : '',
    foam: { ...DEFAULTS.foam, ...(raw.foam ?? {}) },
    gate: {
      engine: String(gate.engine ?? 'js'),
      // Case-local default: the project profile (60 deg / skew 2 / boundary skew 4).
      // The research profile may name any built-in or its own profile explicitly.
      profile: String(gate.profile ?? 'project'),
      profiles,
      minVol: gate.minVol === undefined || gate.minVol === null ? null : Number(gate.minVol),
      script: gate.script ? String(gate.script) : '',
    },
    geometry: {
      registry: raw.geometry?.registry ? String(raw.geometry.registry) : '',
      workRoot: raw.geometry?.workRoot ? String(raw.geometry.workRoot) : '',
      scriptRoots: Array.isArray(raw.geometry?.scriptRoots) ? raw.geometry.scriptRoots.map(String) : [],
    },
    cores: { policy: String(raw.cores?.policy ?? 'explicit'), np: Number(raw.cores?.np ?? 1) },
    raw,
  }
}

/**
 * Walk up from a start directory looking for `sim-project.json`.
 * @returns {{root: string, file: string, profile: object}|null}
 */
export function detectProfile(start = process.cwd(), maxDepth = 12) {
  let dir = resolve(start)
  for (let i = 0; i < maxDepth; i += 1) {
    const file = join(dir, PROFILE_FILE)
    if (existsSync(file)) return { root: dir, file, profile: readProfile(dir, file) }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/** Profile for an explicit root (may be absent — case-local mode). */
export function profileForRoot(root) {
  if (!root) return null
  const file = join(root, PROFILE_FILE)
  if (!existsSync(file)) return null
  return { root, file, profile: readProfile(root, file) }
}
