/**
 * OpenFOAM capability matrix: what this installation actually accepts.
 *
 * Two independent sources, because either one alone lies:
 *   - executables in `$WM_PROJECT_DIR/platforms/*\/bin` — cfMesh is OpenCFD-only, `surfaceFeatures` is
 *     Foundation-only, `foamyHexMesh` was dropped from the Foundation line;
 *   - the annotated case dictionaries shipped in `$WM_PROJECT_DIR/etc/caseDicts/annotated` — they carry the keys
 *     of *this* build (`minMedialAxisAngle` vs `minMedianAxisAngle`, `scale` vs `convertToMeters`,
 *     `locationsInMesh`), which a version table cannot know for a patched build.
 *
 * The result is cached per bashrc: the answer changes only when the installation changes.
 */
import { join } from 'node:path'
import { runBash } from '../../sim-core/lib/process.js'
import { readJson, tail } from './common.js'

export const CAPS_SCHEMA = 'mesh-caps/1'
export const CAPS_MATRIX_SCHEMA = 'mesh-capabilities-matrix/1'
export const CAPS_VERSION = 1

/** Executables worth probing (route and scaffold decisions hang off them). */
export const PROBED_COMMANDS = [
  'blockMesh', 'snappyHexMesh', 'checkMesh', 'decomposePar', 'reconstructParMesh', 'splitMeshRegions',
  'surfaceFeatureExtract', 'surfaceFeatures', 'cartesianMesh', 'pMesh', 'tetMesh', 'foamyHexMesh',
  'gmshToFoam', 'foamRun', 'foamMultiRun', 'simpleFoam', 'chtMultiRegionFoam',
  // utilities the tutorial pipeline and the engine whitelist can schedule (mesh surgery, extrude, polyDual)
  'surfaceMeshExtract', 'PDRblockMesh', 'foamyQuadMesh', 'refineHexMesh', 'setSet', 'redistributePar',
  'collapseEdges', 'extrudeMesh', 'polyDualMesh', 'topoSet', 'subsetMesh', 'createPatch', 'createBaffles',
  'stitchMesh', 'refineMesh', 'moveDynamicMesh', 'extrude2DMesh', 'extrudeToRegionMesh',
]

/** Keys whose presence in the annotated dictionaries decides a dictionary spelling. */
const SNAPPY_KEYS = [
  'minMedialAxisAngle', 'minMedianAxisAngle', 'locationsInMesh', 'relativeSizes', 'castellatedBufferLayer',
  // OpenCFD-only options: the build's own annotated dictionary is the live evidence for them.
  'gapLevel', 'gapLevelIncrement', 'gapMode', 'curvatureLevel', 'leakLevel', 'useLeakClosure',
  'levelIncrement', 'insidePoints', 'outsidePoints', 'layerFields',
]
const BLOCKMESH_KEYS = ['scale', 'convertToMeters']

const PROBE_CACHE = new Map()

function probeScript() {
  const commands = PROBED_COMMANDS.map((name) => `'${name}'`).join(' ')
  // NOTE: `key.snappy.name=$(...)` is not an assignment in bash (dots are not allowed in names) — print instead.
  const snappyKeys = SNAPPY_KEYS
    .map((key) => `printf "key.snappy.${key}=%s\\n" "$(grep -c "${key}" "$SNAPPY_DICT" 2>/dev/null || true)"`)
    .join('; ')
  const blockKeys = BLOCKMESH_KEYS
    .map((key) => `printf "key.blockMesh.${key}=%s\\n" "$(grep -c "${key}" "$BLOCK_DICT" 2>/dev/null || true)"`)
    .join('; ')
  return [
    'printf "version=%s\\n" "${WM_PROJECT_VERSION:-}"',
    'printf "project=%s\\n" "${WM_PROJECT:-}"',
    'printf "projectDir=%s\\n" "${WM_PROJECT_DIR:-}"',
    'SNAPPY_DICT="${WM_PROJECT_DIR:-}/etc/caseDicts/annotated/snappyHexMeshDict"',
    'BLOCK_DICT="${WM_PROJECT_DIR:-}/etc/caseDicts/annotated/blockMeshDict"',
    'printf "dict.snappy=%s\\n" "$([ -f "$SNAPPY_DICT" ] && echo 1 || echo 0)"',
    'printf "dict.blockMesh=%s\\n" "$([ -f "$BLOCK_DICT" ] && echo 1 || echo 0)"',
    snappyKeys,
    blockKeys,
    `for t in ${commands}; do printf "tool.%s=%s\\n" "$t" "$(command -v "$t" 2>/dev/null || true)"; done`,
    'if reconstructParMesh -help 2>&1 | grep -q -- -mergeTol; then echo mergeTol=1; else echo mergeTol=0; fi',
  ].join('; ')
}

function parseProbe(stdout) {
  const out = { version: '', project: '', projectDir: '', dicts: {}, keys: { snappy: {}, blockMesh: {} }, tools: {}, mergeTol: null }
  for (const line of String(stdout).split('\n')) {
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1).trim()
    if (key === 'version') out.version = value
    else if (key === 'project') out.project = value
    else if (key === 'projectDir') out.projectDir = value
    else if (key === 'mergeTol') out.mergeTol = value === '1'
    else if (key === 'dict.snappy') out.dicts.snappy = value === '1'
    else if (key === 'dict.blockMesh') out.dicts.blockMesh = value === '1'
    else if (key.startsWith('key.snappy.')) out.keys.snappy[key.slice('key.snappy.'.length)] = Number(value) > 0
    else if (key.startsWith('key.blockMesh.')) out.keys.blockMesh[key.slice('key.blockMesh.'.length)] = Number(value) > 0
    else if (key.startsWith('tool.') && value) out.tools[key.slice('tool.'.length)] = value
  }
  return out
}

/** `org` for a bare major version (14, 13, 12), `com` for the four-digit OpenCFD tags (2412, v2512, 2606). */
export function distributionOf(raw) {
  const value = String(raw ?? '').trim().replace(/^v/, '')
  if (/^\d{1,2}$/.test(value)) return 'org'
  if (/^\d{4}$/.test(value)) return 'com'
  return 'unknown'
}

/**
 * Probe one installation.
 * @returns {{ok:boolean, schemaVersion:string, bashrc:string, distribution:string, version:string,
 *   commands:Object<string,string>, features:Object<string,boolean>, dictKeys:Object<string,string|boolean>,
 *   dicts:Object<string,boolean>, notes:string[], error?:string}}
 */
export function probeCaps(config) {
  const key = config?.openfoamBashrc || '(none)'
  if (PROBE_CACHE.has(key)) return PROBE_CACHE.get(key)
  const bashrc = config?.openfoamBashrc || ''
  if (!bashrc) {
    const empty = {
      ok: false, schemaVersion: CAPS_SCHEMA, bashrc, distribution: 'unknown', version: '', commands: {},
      features: {}, dictKeys: {}, dicts: {}, notes: ['no OpenFOAM bashrc: pass openfoam (id or path) or set foam in sim-project.json'],
      error: 'no OpenFOAM bashrc',
    }
    PROBE_CACHE.set(key, empty)
    return empty
  }
  const result = runBash(probeScript(), {
    cwd: config.projectRoot || process.cwd(),
    timeoutMs: 120000,
    openfoamBashrc: bashrc,
    maxBuffer: 2 * 1024 * 1024,
  })
  const parsed = parseProbe(result.stdout)
  const ok = result.code === 0 && Boolean(parsed.version)
  const distribution = distributionOf(parsed.version)
  const has = (name) => Boolean(parsed.tools[name])
  const notes = []
  if (!ok) notes.push(`probe failed (exit ${result.code}): ${tail(result.stderr, 400) || 'no output'}`)
  if (parsed.dicts.snappy === false) notes.push('no annotated snappyHexMeshDict: dictionary-key detection fell back to defaults')
  if (parsed.dicts.blockMesh === false) notes.push('no annotated blockMeshDict: assuming `scale` (the modern spelling)')

  const features = {
    cfmesh: has('cartesianMesh'),
    pmesh: has('pMesh'),
    gmsh: has('gmshToFoam'),
    featuresNew: has('surfaceFeatures'),
    featuresOld: has('surfaceFeatureExtract'),
    foamyHexMesh: has('foamyHexMesh'),
    multiRegion: has('splitMeshRegions'),
    modularSolver: has('foamRun'),
    mergeTol: parsed.mergeTol === true,
  }
  const dictKeys = {
    blockMeshUnits: parsed.keys.blockMesh.convertToMeters === true && parsed.keys.blockMesh.scale !== true ? 'convertToMeters' : 'scale',
    featuresDict: features.featuresNew ? 'surfaceFeaturesDict' : 'surfaceFeatureExtractDict',
    layerAxis: parsed.keys.snappy.minMedianAxisAngle === true && parsed.keys.snappy.minMedialAxisAngle !== true
      ? 'minMedianAxisAngle'
      : 'minMedialAxisAngle',
    locationsInMesh: parsed.keys.snappy.locationsInMesh === true,
    castellatedBufferLayer: parsed.keys.snappy.castellatedBufferLayer === true,
    relativeSizes: parsed.keys.snappy.relativeSizes === true,
  }
  if (features.featuresNew && features.featuresOld) notes.push('both surfaceFeatures and surfaceFeatureExtract exist: the new dictionary wins')
  if (distribution === 'unknown' && ok) notes.push(`unrecognised version "${parsed.version}": distribution-specific routes stay guarded`)

  const caps = {
    ok,
    schemaVersion: CAPS_SCHEMA,
    bashrc,
    distribution,
    version: parsed.version,
    project: parsed.project,
    commands: parsed.tools,
    probed: PROBED_COMMANDS.slice(),
    features,
    dictKeys,
    dicts: parsed.dicts,
    notes,
    error: ok ? null : (notes[0] ?? 'probe failed'),
  }
  PROBE_CACHE.set(key, caps)
  return caps
}

/** Compact form for tool output and handoff notes. */
export function capsSummary(caps) {
  if (!caps) return null
  return {
    ok: caps.ok,
    distribution: caps.distribution,
    version: caps.version,
    commands: Object.keys(caps.commands).sort(),
    features: caps.features,
    dictKeys: caps.dictKeys,
    notes: caps.notes,
  }
}

/** One-line human sentence used in `next` and in the notes of other tools. */
export function capsSentence(caps) {
  if (!caps?.ok) return `OpenFOAM capabilities unknown: ${caps?.error ?? 'probe failed'}`
  const parts = [`OpenFOAM ${caps.version} (${caps.distribution})`]
  parts.push(`cfMesh ${caps.features.cfmesh ? 'yes' : 'no'}`)
  parts.push(`gmsh ${caps.features.gmsh ? 'yes' : 'no'}`)
  parts.push(`features dict ${caps.dictKeys.featuresDict}`)
  parts.push(`layer key ${caps.dictKeys.layerAxis}`)
  parts.push(`blockMesh key ${caps.dictKeys.blockMeshUnits}`)
  return parts.join(' · ')
}

/** Declared capability matrix, shipped as data/capabilities.json (utilities x key x build). */
let MATRIX_CACHE = null

export function loadCapabilitiesMatrix(dataDir) {
  const file = join(dataDir, 'capabilities.json')
  if (MATRIX_CACHE && MATRIX_CACHE.file === file) return MATRIX_CACHE.matrix
  let matrix = null
  try {
    matrix = readJson(file)
  } catch {
    matrix = null
  }
  MATRIX_CACHE = { file, matrix }
  return matrix
}

/**
 * Merge the declared matrix with the live probe of *this* installation.
 *
 * The live probe wins (it is the running binary), the matrix supplies the keys the probe does not
 * cover and the evidence trail; every disagreement is reported instead of hidden.
 */
export function capabilityMatrix(caps, matrix) {
  if (!caps?.ok) return null
  if (!matrix?.builds) return { ok: false, reason: 'no data/capabilities.json' }
  const bare = (value) => String(value ?? '').replace(/^v/i, '')
  const entries = Object.entries(matrix.builds)
  const match = entries.find(([, build]) => bare(build.version) === bare(caps.version))
    ?? entries.find(([, build]) => build.distribution === caps.distribution)
  if (!match) return { ok: false, reason: `no matrix row for ${caps.distribution} ${caps.version}` }
  const [name, build] = match
  const utilities = {}
  const snappyKeys = {}
  const disagreements = []
  for (const util of matrix.definitions?.utilities ?? []) {
    const declared = build.utilities?.[util] ?? null
    const wasProbed = Boolean(caps.probed?.includes(util))
    // commands is a {name: absolute path} map from `command -v` (absent = tool missing), so the
    // VALUE decides: hasOwnProperty alone reported probed-but-missing tools as live=true.
    const live = wasProbed ? Boolean(caps.commands?.[util]) : null
    utilities[util] = live === null ? declared : live
    if (declared !== null && live !== null && declared !== live) {
      disagreements.push({ kind: 'utility', name: util, declared, live })
    }
  }
  for (const key of matrix.definitions?.snappyKeys ?? []) {
    const declared = build.snappyKeys?.[key] ?? null
    const probed = caps.keys?.snappy?.[key]
    const value = typeof probed === 'boolean' ? probed : declared
    snappyKeys[key] = value
    if (typeof probed === 'boolean' && declared !== null && declared !== probed) {
      disagreements.push({ kind: 'snappyKey', name: key, declared, live: probed })
    }
  }
  const present = (map) => Object.entries(map).filter(([, v]) => v === true).map(([k]) => k)
  return {
    schema: CAPS_MATRIX_SCHEMA,
    build: name,
    distribution: build.distribution,
    version: build.version,
    install: build.install ?? null,
    values: { utilities, snappyKeys },
    supported: { utilities: present(utilities), snappyKeys: present(snappyKeys) },
    disagreements,
    // Keys the build accepts but its own annotated dictionary never documents (com2606: outsidePoints,
    // present in the com source line snappyVoxelMeshDriver.C:473, absent from the 2606 template).
    supportedButUndocumented: build.supportedButUndocumented ?? [],
    evidence: build.evidence ?? null,
    notes: matrix.notes ?? [],
  }
}

/** Drop the cache (tests, or after installing another OpenFOAM). */
export function clearCapsCache() {
  PROBE_CACHE.clear()
  MATRIX_CACHE = null
}
