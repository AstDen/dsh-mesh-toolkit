/**
 * mesh-handoff/1 — the file channel between the mesh toolkit and a solver-side workbench.
 *
 * The contract is documented in docs/WORKBENCH-CONTRACT.md (published repo). This module is the only
 * place that knows the on-disk shape: `buildHandoff` assembles it from facts that already exist
 * (passport, gate targets, boundary patches, blockMeshDict/snappyHexMeshDict), `writeHandoff` puts it
 * at `<caseDir>/handoff.json`. Nothing here guesses: a value that cannot be read stays null and the
 * reason is recorded in `recommendations.notes`.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const HANDOFF_SCHEMA = 'mesh-handoff/1'
export const HANDOFF_FILE = 'handoff.json'

/** Patch roles the consumer accepts (docs/WORKBENCH-CONTRACT.md §3.2). */
export const PATCH_ROLES = ['inlet', 'outlet', 'wall', 'symmetry', 'cyclic', 'empty', 'interface', 'wedge', 'unknown']

const TYPE_ROLE = {
  wall: 'wall',
  mappedWall: 'wall',
  symmetry: 'symmetry',
  symmetryPlane: 'symmetry',
  cyclic: 'cyclic',
  cyclicAMI: 'cyclic',
  empty: 'empty',
  wedge: 'wedge',
  processor: 'interface',
  processorCyclic: 'interface',
  mapped: 'interface',
  patch: 'unknown',
}

/** Name heuristics are advisory: a type-driven role wins, a name only refines an unknown one. */
function roleFromName(name) {
  const n = String(name ?? '').toLowerCase()
  if (/^(inlet|in|inflow|inlet_|entry)/.test(n)) return 'inlet'
  if (/^(outlet|out|outflow|exit)/.test(n)) return 'outlet'
  if (/^(wall|walls|solid|body|interface)/.test(n)) return n.startsWith('interface') ? 'interface' : 'wall'
  if (/^(sym|symmetry|plane)/.test(n)) return 'symmetry'
  return null
}

/** Role of one boundary patch: type first, name as a refinement, never invented. */
export function patchRole(patch) {
  const byType = TYPE_ROLE[patch?.type] ?? 'unknown'
  const byName = roleFromName(patch?.name)
  if (byType === 'unknown' && byName) return byName
  if (byType === 'wall' && byName === 'interface') return 'interface'
  if (byType === 'wall' && (byName === 'inlet' || byName === 'outlet')) return byName
  return byType
}

/**
 * STL->case scale actually used by the mesh, read from the dictionaries (metres per STL unit).
 * A scaffolded case keeps the background mesh in metres and scales only the surface in
 * `snappyHexMeshDict geometry { scale 0.001; }`; a mm-domain case scales everything in
 * `blockMeshDict` (`scale`/`convertToMeters`). The first one wins because it is what snappy used.
 */
export function scaleFromBlockMeshDict(caseDir) {
  const snappy = join(caseDir, 'system', 'snappyHexMeshDict')
  if (existsSync(snappy)) {
    const text = readFileSync(snappy, 'utf8')
    const body = dictBlock(text, 'geometry') ?? text
    const m = body.match(/^\s*scale\s+([^;]+);/m)
    if (m) {
      const raw = m[1].trim().replace(/^\(|\)$/g, '')
      const first = Number(raw.split(/\s+/)[0])
      if (Number.isFinite(first) && first > 0) return { scale: first, key: 'scale', file: 'system/snappyHexMeshDict' }
    }
  }
  const file = join(caseDir, 'system', 'blockMeshDict')
  if (!existsSync(file)) return { scale: null, key: null, file: null }
  const text = readFileSync(file, 'utf8')
  for (const key of ['scale', 'convertToMeters']) {
    const m = text.match(new RegExp(`^\\s*${key}\\s+([^;]+);`, 'm'))
    if (!m) continue
    const raw = m[1].trim().replace(/^\(|\)$/g, '')
    const first = Number(raw.split(/\s+/)[0])
    if (Number.isFinite(first) && first > 0) return { scale: first, key, file: 'system/blockMeshDict' }
  }
  return { scale: null, key: null, file: 'system/blockMeshDict' }
}

/** Inner text of `keyword { ... }` with balanced braces (null when absent). */
function dictBlock(text, keyword) {
  const at = text.search(new RegExp(`\\b${keyword}\\s*\\{`))
  if (at < 0) return null
  const open = text.indexOf('{', at)
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  return null
}

/** Authoritative bounding box: the points actually meshed (constant/polyMesh/points). */
function bboxFromPoints(caseDir) {
  const file = join(caseDir, 'constant', 'polyMesh', 'points')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const start = text.indexOf('\n(')
  const body = start >= 0 ? text.slice(start) : text
  const re = /\(\s*(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s+(-?\d+(?:\.\d+)?(?:e[-+]?\d+)?)\s*\)/g
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  let m
  while ((m = re.exec(body)) !== null) {
    for (let a = 0; a < 3; a += 1) {
      const v = Number(m[a + 1])
      if (!Number.isFinite(v)) continue
      if (v < min[a]) min[a] = v
      if (v > max[a]) max[a] = v
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return null
  return { min, max }
}

/** Legacy helper kept for dictionaries whose vertices are literal numbers, not $vars. */
function bboxFromVertices(text) {
  const m = text.match(/vertices\s*\(([\s\S]*?)\)\s*;/)
  if (!m) return null
  const nums = m[1].match(/-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi)
  if (!nums || nums.length < 9) return null
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < nums.length; i += 3) {
    for (let a = 0; a < 3; a += 1) {
      const v = Number(nums[i + a])
      if (!Number.isFinite(v)) continue
      if (v < min[a]) min[a] = v
      if (v > max[a]) max[a] = v
    }
  }
  if (!min.every(Number.isFinite) || !max.every(Number.isFinite)) return null
  return { min, max }
}

/** Domain geometry and the background selection, read from the case dictionaries (best effort). */
export function domainFromCase(caseDir) {
  const out = { bbox_m: null, locationInMesh: null, cells: null, levels: null, defaultLevel: null, domainType: null }
  const block = join(caseDir, 'system', 'blockMeshDict')
  if (existsSync(block)) {
    const text = readFileSync(block, 'utf8')
    out.bbox_m = bboxFromPoints(caseDir) ?? bboxFromVertices(text)
    const hex = text.match(/hex\s*\(([^)]*)\)\s*\(\s*([^)]*)\)/)
    if (hex) {
      const counts = hex[2].trim().split(/\s+/).map(Number).filter(Number.isFinite)
      if (counts.length === 3) out.cells = counts
    }
    const blockType = text.match(/type\s+(box|sphere|cylinder|...)\s*;/)
    if (blockType) out.domainType = blockType[1]
  }
  const snappy = join(caseDir, 'system', 'snappyHexMeshDict')
  if (existsSync(snappy)) {
    const text = readFileSync(snappy, 'utf8')
    const loc = text.match(/locationInMesh\s*\(\s*([^)]*)\)/)
    if (loc) {
      const xyz = loc[1].trim().split(/\s+/).map(Number)
      if (xyz.length === 3 && xyz.every(Number.isFinite)) out.locationInMesh = xyz
    }
    const dflt = text.match(/defaultLevel\s+(\d+)\s*;/)
    if (dflt) out.defaultLevel = Number(dflt[1])
    const levels = {}
    const surfaces = dictBlock(text, 'refinementSurfaces')
    if (surfaces) {
      // Entries nest (patchInfo { type wall; }), so take each `name {` and slice its balanced block.
      const head = /([A-Za-z0-9_.\-]+)\s*\{/g
      let h
      while ((h = head.exec(surfaces)) !== null) {
        const open = surfaces.indexOf('{', h.index)
        let depth = 0
        let end = -1
        for (let i = open; i < surfaces.length; i += 1) {
          if (surfaces[i] === '{') depth += 1
          else if (surfaces[i] === '}') {
            depth -= 1
            if (depth === 0) { end = i; break }
          }
        }
        if (end < 0) break
        const body = surfaces.slice(open + 1, end)
        const lv = body.match(/level\s*\(\s*(\d+)\s+(\d+)\s*\)/)
        if (lv) levels[h[1]] = [Number(lv[1]), Number(lv[2])]
        head.lastIndex = end
      }
    }
    if (Object.keys(levels).length) out.levels = levels
    out.domainType = out.domainType ?? 'box'
  }
  return out
}

/** Provenance of every STL the case carries (sha256, size, path relative to the case). */
export function stlProvenance(caseDir) {
  const dir = join(caseDir, 'constant', 'triSurface')
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.stl')).sort()
  return files.map((name) => {
    const abs = join(dir, name)
    const bytes = readFileSync(abs)
    return {
      name,
      file: `constant/triSurface/${name}`,
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  })
}

/** Quality block from the gate targets of mesh_check (first region wins for the headline numbers). */
export function qualityFromGate({ profile, minVol, verdict, targets = [], passport = null }) {
  const first = targets[0] ?? {}
  const metrics = first.metrics ?? {}
  const violations = []
  for (const t of targets) {
    for (const v of t.violations ?? []) violations.push(v)
  }
  return {
    profile: profile ?? null,
    minVol: minVol ?? first.minVol ?? first.thresholds?.minVol ?? null,
    verdict: verdict ?? first.verdict ?? null,
    maxNonOrtho: metrics.maxNonOrtho ?? null,
    avgNonOrtho: metrics.avgNonOrtho ?? null,
    maxSkewness: metrics.maxSkewness ?? null,
    minVolume: metrics.minVolume ?? null,
    cells: metrics.cells ?? null,
    violations,
    passport: passport
      ? { path: 'mesh-passport.json', status: passport.status ?? null, createdAt: passport.createdAt ?? null }
      : null,
  }
}

/** Roles grouped for the workbench: what is a wall, what still has to be retyped. */
export function roleSummary(patches) {
  const roles = { inlet: [], outlet: [], wall: [], symmetry: [], cyclic: [], empty: [], interface: [], wedge: [], unknown: [] }
  for (const p of patches ?? []) {
    const role = PATCH_ROLES.includes(p.role) ? p.role : 'unknown'
    roles[role].push(p.name)
  }
  const flowReady = roles.inlet.length > 0 && roles.outlet.length > 0
  return { roles, flowReady }
}

/**
 * Assemble a `mesh-handoff/1` document. Every argument is optional so the function also serves
 * mesh_deliver (where only the packaged case and the delivery report exist).
 */
export function buildHandoff({
  caseDir,
  requestId = null,
  attempt = 0,
  producer = {},
  units = 'mm',
  geometry = null,
  mesh = null,
  quality = null,
  patches = null,
  recommendations = null,
  files = null,
  history = [],
  next = null,
}) {
  const scale = scaleFromBlockMeshDict(caseDir)
  const domain = domainFromCase(caseDir)
  const stls = stlProvenance(caseDir)
  const patchList = (patches ?? []).map((p) => ({
    region: p.region ?? null,
    name: p.name,
    type: p.type ?? null,
    role: PATCH_ROLES.includes(p.role) ? p.role : patchRole(p),
    nFaces: p.nFaces ?? null,
    area_m2: p.area_m2 ?? null,
  }))
  const { roles, flowReady } = roleSummary(patchList)
  const notes = []
  if (!flowReady) {
    const walls = roles.wall.length ? roles.wall : patchList.map((p) => p.name)
    const shape = Object.entries(roles).filter(([, names]) => names.length).map(([role, names]) => `${role}: ${names.join(', ')}`).join('; ')
    notes.push(`patches are not split into inlet/outlet yet (${patchList.length} patch(es) — ${shape}): retype before a flow run (mesh_patch_types, plan A2; until then foamDictionary -entry boundary.<patch>.type)`)
    if (next == null || (Array.isArray(next) && next.length === 0)) next = [{ tool: 'mesh_patch_types', args: { caseDir: '.', roles: { inlet: [], outlet: [], walls } } }]
  }
  if (scale.scale == null) notes.push('scale/convertToMeters not found in system/blockMeshDict: the workbench must not trust units.scale')
  if (!patchList.length) notes.push('no boundary patches read from constant/polyMesh/boundary')

  const geometryOut = {
    kind: 'stl',
    family: null,
    stl: stls[0]?.file ?? null,
    sha256: stls[0]?.sha256 ?? null,
    bbox_m: domain.bbox_m,
    volume_m3: null,
    qa: null,
    stls,
    ...(geometry ?? {}),
  }
  const meshOut = {
    route: null,
    selection: {
      cellSize_m: null,
      cells: domain.cells,
      levels: domain.levels,
      defaultLevel: domain.defaultLevel,
      ...(mesh?.selection ?? {}),
    },
    cells: quality?.cells ?? null,
    points: null,
    faces: null,
    regions: [...new Set(patchList.map((p) => p.region).filter(Boolean))],
    layers: { nLayers: null, coverage: null },
    ...(mesh ?? {}),
    selection: {
      cellSize_m: null,
      cells: domain.cells,
      levels: domain.levels,
      defaultLevel: domain.defaultLevel,
      ...(mesh?.selection ?? {}),
    },
  }
  const rec = {
    suggestedFamily: 'incompressible',
    suggestedSolverSetup: { algorithm: 'SIMPLE', turbulence: 'laminar' },
    yPlus: { target: null, firstLayer_m: null },
    notes: [...(recommendations?.notes ?? []), ...notes],
    ...(recommendations ?? {}),
  }
  rec.notes = [...new Set(rec.notes)]

  return {
    schemaVersion: HANDOFF_SCHEMA,
    requestId,
    attempt,
    producer: {
      plugin: producer.plugin ?? null,
      version: producer.version ?? null,
      openfoam: producer.openfoam ?? { distribution: null, version: null, bashrc: null },
    },
    units: { stl: units, case: 'm', scale: scale.scale ?? null, key: scale.key, source: scale.file },
    geometry: geometryOut,
    mesh: meshOut,
    quality: quality ?? null,
    patches: patchList,
    roles,
    domain: { type: domain.domainType ?? 'box', bbox_m: domain.bbox_m, locationInMesh: domain.locationInMesh },
    recommendations: rec,
    files: {
      case: '.',
      polyMesh: 'constant/polyMesh',
      handoff: HANDOFF_FILE,
      delivery: files?.delivery ?? null,
      ...(files ?? {}),
    },
    history: Array.isArray(history) ? history : [],
    next: next ?? [],
    createdAt: new Date().toISOString(),
  }
}

/** Write the document at `<caseDir>/handoff.json`; returns {file, bytes, handoff}. */
export function writeHandoff(caseDir, handoff) {
  const file = join(caseDir, HANDOFF_FILE)
  const text = `${JSON.stringify(handoff, null, 2)}\n`
  writeFileSync(file, text)
  return { file, bytes: text.length, handoff }
}

/** Read an existing handoff (null when absent or unparsable). */
export function readHandoff(caseDir) {
  const file = join(caseDir, HANDOFF_FILE)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/** Structural check used by the toolkit service and tests: returns [] when valid. */
export function validateHandoff(doc) {
  const problems = []
  if (!doc || typeof doc !== 'object') return ['handoff is not an object']
  if (doc.schemaVersion !== HANDOFF_SCHEMA) problems.push(`schemaVersion is ${doc.schemaVersion}, expected ${HANDOFF_SCHEMA}`)
  if (!doc.units || doc.units.case !== 'm') problems.push('units.case must be "m"')
  if (doc.quality && doc.quality.verdict !== 'PASS') problems.push(`quality.verdict is ${doc.quality.verdict}: the workbench must not launch a run (call mesh_revise)`)
  for (const p of doc.patches ?? []) {
    if (!PATCH_ROLES.includes(p.role)) problems.push(`patch ${p.name} has role ${p.role}, not in the enumeration`)
  }
  if (!Array.isArray(doc.next)) problems.push('next must be an array')
  return problems
}
