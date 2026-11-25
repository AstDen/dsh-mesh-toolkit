/**
 * sim-core/lib/passport.js — mesh passports and case manifests.
 *
 * A passport records what a mesh is and how it was produced, together with hashes
 * of its polyMesh files, so later tools can answer "is this mesh still the one that
 * was gated?" without re-running checkMesh. A manifest records which solver and
 * boundary layout the scaffold created, so downstream cases can read it instead of
 * guessing from dictionaries.
 * @module sim-core/lib/passport
 */
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { fileStat, nowIso, readJson, sha256FileSync, writeJsonAtomic } from './util.js'

export const MESH_PASSPORT_FILE = 'mesh-passport.json'
export const CASE_MANIFEST_FILE = 'case-manifest.json'
export const PASSPORT_SCHEMA = 1

const MESH_FILES = ['boundary', 'points', 'owner', 'neighbour', 'faces']

/** Path of the passport for a case. */
export function meshPassportPath(caseDir) {
  return join(caseDir, MESH_PASSPORT_FILE)
}

/** Path of the case manifest for a case. */
export function caseManifestPath(caseDir) {
  return join(caseDir, CASE_MANIFEST_FILE)
}

/** SHA256 of a string (used for composite hashes). */
function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Hash and stat one directory of polyMesh files. */
export function hashMeshDir(dir, caseDir = dir) {
  const files = {}
  for (const name of MESH_FILES) {
    const full = join(dir, name)
    if (!existsSync(full)) continue
    const stat = statSync(full)
    files[relative(caseDir, full)] = {
      size: stat.size,
      mtimeMs: Math.round(stat.mtimeMs),
      sha256: sha256FileSync(full),
    }
  }
  return files
}

/**
 * Build a passport from gate results.
 * @param {object} options
 * @param {string} options.caseDir
 * @param {string} options.route mesher route id (snappy|cfmesh|gmsh|...)
 * @param {string[]} [options.regions]
 * @param {object|null} [options.gate] one gateTarget report (base mesh)
 * @param {object[]} [options.gateTargets] per-region reports
 * @param {string} [options.units]
 * @param {object|null} [options.layers]
 * @param {string[]} [options.logs]
 * @param {object} [options.generator] {name, version, plugin}
 */
export function buildMeshPassport(options) {
  const {
    caseDir, route, regions = [], gate = null, gateTargets = [], units = 'm',
    layers = null, logs = [], generator = null,
  } = options
  const regionHashes = {}
  for (const region of regions) regionHashes[region] = hashMeshDir(join(caseDir, 'constant', region, 'polyMesh'), caseDir)
  const baseHashes = hashMeshDir(join(caseDir, 'constant', 'polyMesh'), caseDir)
  const meshHash = {
    base: baseHashes,
    regions: regionHashes,
    boundarySha256: baseHashes['constant/polyMesh/boundary']?.sha256 ?? null,
    pointsSha256: baseHashes['constant/polyMesh/points']?.sha256 ?? null,
    cellsSha256: sha256Text(
      `${baseHashes['constant/polyMesh/owner']?.sha256 ?? ''}:`
      + `${baseHashes['constant/polyMesh/neighbour']?.sha256 ?? ''}`,
    ),
  }
  const cells = regions.length
    ? gateTargets.reduce((sum, item) => sum + (item?.metrics?.cells ?? 0), 0)
    : (gate?.metrics?.cells ?? null)
  const passport = {
    schemaVersion: PASSPORT_SCHEMA,
    case: caseDir,
    caseName: caseDir.split('/').filter(Boolean).pop() ?? 'case',
    route,
    regions,
    units,
    dimension: 3,
    cells,
    gate: gate ? passportGate(gate) : null,
    regionGate: gateTargets.map((item) => ({ region: item.region ?? 'base', ...passportGate(item) })),
    meshHash,
    layers,
    logs,
    generator,
    createdAt: nowIso(),
  }
  return passport
}

function passportGate(result) {
  const metrics = result?.metrics ?? {}
  return {
    profile: result?.profile ?? null,
    thresholds: result?.thresholds ?? null,
    minVol: result?.minVol ?? null,
    maxNonOrtho: metrics.maxNonOrtho ?? null,
    aveNonOrtho: metrics.avgNonOrtho ?? null,
    maxSkewness: metrics.maxSkewness ?? null,
    minVolume: metrics.minVolume ?? null,
    facesOverThreshold: metrics.severelyNonOrtho ?? null,
    failedChecks: metrics.failedChecks ?? null,
    verdict: result?.verdict ?? 'UNKNOWN',
    engine: result?.engine ?? 'js',
  }
}

/** Write a passport atomically. */
export function writeMeshPassport(caseDir, passport) {
  const target = meshPassportPath(caseDir)
  writeJsonAtomic(target, passport)
  return target
}

/** Read a passport, or null. */
export function readMeshPassport(caseDir) {
  const file = meshPassportPath(caseDir)
  if (!existsSync(file)) return null
  try { return readJson(file) } catch { return null }
}

/**
 * Is the passport still describing the mesh on disk?
 * Cheap check first (size + mtime); sha256 only for files whose stat changed, so a
 * touched-but-identical file does not force a full re-read.
 * @returns {{fresh: boolean, status: string, changed: string[], checked: number}}
 */
export function passportFreshness(caseDir, passport = readMeshPassport(caseDir)) {
  if (!passport) return { fresh: false, status: 'missing', changed: [], checked: 0 }
  const recorded = passport.meshHash ?? {}
  const entries = []
  for (const [file, info] of Object.entries(recorded.base ?? {})) entries.push({ file, info })
  for (const [region, files] of Object.entries(recorded.regions ?? {})) {
    for (const [file, info] of Object.entries(files ?? {})) entries.push({ file, info })
  }
  const changed = []
  let checked = 0
  for (const { file, info } of entries) {
    const full = resolve(caseDir, file)
    if (!existsSync(full)) { changed.push(`${file} (missing)`); continue }
    const stat = fileStat(full)
    checked += 1
    if (stat.size !== info.size || Math.round(stat.mtimeMs) !== info.mtimeMs) {
      if (sha256FileSync(full) !== info.sha256) changed.push(`${file} (content changed)`)
    }
  }
  return {
    fresh: changed.length === 0,
    status: changed.length === 0 ? 'fresh' : 'stale',
    changed,
    checked,
    createdAt: passport.createdAt ?? null,
  }
}

/** Build a case manifest from scaffold facts. */
export function buildCaseManifest(options = {}) {
  return {
    schemaVersion: PASSPORT_SCHEMA,
    solver: options.solver ?? null,
    algorithm: options.algorithm ?? null,
    compressible: Boolean(options.compressible),
    phases: options.phases ?? null,
    turbulence: options.turbulence ?? null,
    units: options.units ?? 'm',
    dimension: options.dimension ?? 3,
    patches: options.patches ?? [],
    createdBy: options.createdBy ?? null,
    createdAt: nowIso(),
  }
}

/** Write a case manifest atomically. */
export function writeCaseManifest(caseDir, manifest) {
  const target = caseManifestPath(caseDir)
  writeJsonAtomic(target, manifest)
  return target
}

/** Read a case manifest, or null. */
export function readCaseManifest(caseDir) {
  const file = caseManifestPath(caseDir)
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return null }
}

/** Passport/manifest paths are readable summary aliases used in tool output. */
export function passportSummary(passport) {
  if (!passport) return null
  return {
    case: passport.case,
    route: passport.route,
    regions: passport.regions,
    cells: passport.cells,
    gate: passport.gate?.verdict ?? null,
    profile: passport.gate?.profile ?? null,
    createdAt: passport.createdAt,
  }
}

/** Exported for tests. */
export { MESH_FILES }
