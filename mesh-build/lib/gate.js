/**
 * mesh-build/lib/gate.js — checkMesh and the project quality gate per region.
 *
 * Tools/qa/mesh_gate.sh builds its own overlay and enables OpenFOAM's
 * `-meshQuality` checks, which plain `checkMesh` does NOT run. Multi-region
 * cases are gated region by region through thin overlays (constant/polyMesh
 * points at the region mesh), exactly like experiments/exp-018 did.
 * @module mesh-build/lib/gate
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import { displayPath, q, runBash, tail } from './common.js'

/** Region directories under constant/ that hold a polyMesh. */
export function detectRegions(caseDir) {
  const constant = join(caseDir, 'constant')
  if (!existsSync(constant)) return []
  return readdirSync(constant, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'polyMesh')
    .map((entry) => entry.name)
    .filter((name) => existsSync(join(constant, name, 'polyMesh', 'boundary')))
    .sort()
}

/** Mesher versions from checkMesh output. */
export function parseMeshMetrics(log) {
  const text = String(log ?? '')
  const num = (re) => {
    const m = text.match(re)
    return m ? Number(m[1]) : null
  }
  const int = (re) => {
    const m = text.match(re)
    return m ? Number(m[1]) : null
  }
  const layer = text.match(/Added (\d+) out of (\d+) cells \(([\d.]+)%\)/)
  const thresholds = []
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(.+?)\s*:\s*(\d+)\s*$/)
    // Only checkMesh -meshQuality lines carry a '<' or '>' threshold and a nonzero count,
    // e.g. "faces with face pyramid volume < 1e-14 : 9". Header lines like "PID : 160851"
    // or "boundary patches : 4" are not violations.
    if (m && Number(m[2]) > 0 && /[<>]/.test(m[1])) {
      thresholds.push(`${m[1]} : ${m[2]}`)
    }
  }
  return {
    cells: int(/^\s*cells:\s*(\d+)/m) ?? int(/\bcells=(\d+)/),
    points: int(/^\s*points:\s*(\d+)/m),
    faces: int(/^\s*faces:\s*(\d+)/m),
    maxNonOrtho: num(/Mesh non-orthogonality Max:\s*([\d.]+)/) ?? num(/maxNonOrtho=\{?([\d.]+)\}?°/),
    avgNonOrtho: num(/Mesh non-orthogonality Max:\s*[\d.]+\s*average:\s*([\d.]+)/) ?? num(/avg=\{?([\d.]+)\}?°/),
    severelyNonOrtho: int(/Number of severely non-orthogonal \(> 70 degrees\) faces:\s*(\d+)/) ?? int(/faces>\d+°=(\d+)/),
    maxSkewness: num(/Max skewness =\s*([\d.]+)/) ?? num(/maxSkew=([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/),
    minVolume: num(/Min volume =\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/) ?? num(/minVol=([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)/),
    failedChecks: int(/Failed\s+(\d+)\s+mesh checks/),
    meshOk: /Mesh OK\./.test(text) || /verdict=OK/.test(text),
    thresholdViolations: thresholds,
    layers: layer ? { added: Number(layer[1]), outOf: Number(layer[2]), percent: Number(layer[3]) } : null,
  }
}

function gateTool(config) {
  return join(config.projectRoot, 'tools', 'qa', 'mesh_gate.sh')
}

/** Remove an overlay directory safely (only inside the plugin work root). */
function freshDir(dir, workRoot) {
  const root = resolve(workRoot)
  if (dir !== root && !dir.startsWith(root.endsWith(sep) ? root : root + sep)) return null
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Build an overlay case: constant/polyMesh -> region mesh, system copied. */
export function buildOverlay(config, caseDir, region) {
  const name = `${basename(caseDir)}${region ? `-${region}` : ''}`
  const workRoot = join(config.projectRoot, config.workRoot)
  const overlay = freshDir(join(workRoot, 'gate', name), workRoot)
  if (!overlay) throw new Error(`refusing to build an overlay outside ${config.workRoot}: ${overlay}`)
  mkdirSync(join(overlay, 'constant'), { recursive: true })
  const mesh = region ? join(caseDir, 'constant', region, 'polyMesh') : join(caseDir, 'constant', 'polyMesh')
  if (!existsSync(mesh)) throw new Error(`no polyMesh: ${mesh}`)
  symlinkSync(mesh, join(overlay, 'constant', 'polyMesh'))
  const system = join(caseDir, 'system')
  if (existsSync(system)) cpSync(system, join(overlay, 'system'), { recursive: true })
  mkdirSync(join(overlay, '0'), { recursive: true })
  if (region && existsSync(join(caseDir, '0', region))) symlinkSync(join(caseDir, '0', region), join(overlay, '0', region))
  return overlay
}

/** Run checkMesh on a case/region through an overlay; parses metrics. */
export function checkMesh(config, caseDir, region = null) {
  const overlay = buildOverlay(config, caseDir, region)
  const result = runBash(`checkMesh -case ${q(overlay)}`, {
    cwd: overlay,
    timeoutMs: 1800000,
    openfoamBashrc: config.openfoamBashrc,
  })
  const logFile = join(overlay, 'checkMesh.log')
  writeFileSync(logFile, `$ checkMesh -case ${overlay}\nexit code: ${result.code}\n\n${result.stdout}\n${result.stderr}`, 'utf8')
  return {
    region: region ?? 'base',
    code: result.code,
    metrics: parseMeshMetrics(`${result.stdout}\n${result.stderr}`),
    log: displayPath(config, logFile),
    stdoutTail: tail(result.stdout, 2500),
    stderrTail: tail(result.stderr, 2500),
  }
}

/** Run tools/qa/mesh_gate.sh on the case or one region. */
export function runGate(config, caseDir, options = {}) {
  const region = options.region ?? null
  const profile = options.profile ?? 'project'
  const overlay = buildOverlay(config, caseDir, region)
  const args = ['--case', overlay, '--profile', profile]
  if (options.minVol != null) args.push('--min-vol', String(options.minVol))
  const logFile = join(overlay, 'mesh_gate.log')
  if (options.log) args.push('--log', logFile)
  const command = [q(gateTool(config)), ...args.map((a) => q(a))].join(' ')
  const result = runBash(command, {
    cwd: config.projectRoot,
    timeoutMs: 1800000,
    openfoamBashrc: config.openfoamBashrc,
  })
  // mesh_gate writes the raw checkMesh log to <project>/.cache/qa/gate_<case>.log;
  // merge it with the summary so cells/skew/threshold violations are parsed too.
  let checkMeshLog = ''
  try {
    checkMeshLog = readFileSync(join(config.projectRoot, '.cache', 'qa', `gate_${basename(overlay)}.log`), 'utf8')
  } catch { checkMeshLog = '' }
  const logText = `${result.stdout}\n${result.stderr}`
  writeFileSync(join(overlay, 'gate-output.log'), `${logText}\n--- checkMesh ---\n${checkMeshLog}`, 'utf8')
  return {
    region: region ?? 'base',
    profile,
    minVol: options.minVol ?? null,
    code: result.code,
    pass: result.code === 0,
    metrics: parseMeshMetrics(`${logText}\n${checkMeshLog}`),
    log: displayPath(config, join(overlay, 'gate-output.log')),
    stdoutTail: tail(result.stdout, 4000),
    stderrTail: tail(result.stderr, 4000),
  }
}

/**
 * Gate every region (or the base case) and summarise.
 * @returns {{regions: string[], results: object[], pass: boolean, verdict: string}}
 */
export function gateCase(config, caseDir, options = {}) {
  const regions = options.regions && options.regions.length ? options.regions : detectRegions(caseDir)
  const targets = regions.length ? regions : [null]
  const results = targets.map((region) => runGate(config, caseDir, { ...options, region }))
  const failing = results.filter((r) => !r.pass)
  const verdict = failing.length === 0 ? 'PASS' : 'FAIL'
  return {
    caseDir,
    regions,
    targets: targets.map((t) => t ?? 'base'),
    pass: failing.length === 0,
    verdict,
    failingRegions: failing.map((r) => r.region),
    results,
  }
}
