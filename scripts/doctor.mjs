#!/usr/bin/env node
/**
 * doctor: check an installation before the first run.
 *
 * Answers the four questions that actually block a new user — can the plugins load, is OpenFOAM
 * reachable, is a project (or the portable fallback) resolvable, and are the optional pieces
 * (cfMesh, gmsh, python families, ParaView) present. Every line prints PASS / WARN / FAIL with
 * the exact next action, and the exit code is 1 only when something FAILs.
 *
 *   node scripts/doctor.mjs
 *   node scripts/doctor.mjs --json
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = existsSync(join(REPO, 'plugins', 'sim-core')) ? join(REPO, 'plugins') : REPO
const JSON_OUT = process.argv.includes('--json')

const rows = []
const add = (level, area, detail, fix) => rows.push({ level, area, detail, ...fix ? { fix } : {} })
const PASS = 'PASS'
const WARN = 'WARN'
const FAIL = 'FAIL'

function run(command, args, options = {}) {
  try {
    return { ok: true, out: execFileSync(command, args, { encoding: 'utf8', timeout: 60_000, ...options }).trim() }
  } catch (error) {
    return { ok: false, out: String(error.stdout ?? '').trim(), error: String(error.stderr ?? error.message).trim() }
  }
}

// 1. runtime
const major = Number(process.versions.node.split('.')[0])
add(major >= 20 ? PASS : FAIL, 'node', `${process.versions.node} (need >= 20)`, major >= 20 ? null : { action: 'install Node 20 or newer' })

// 2. package layout
const trees = ['mesh-build', 'mesh-stl', 'sim-core'].filter((name) => existsSync(join(PKG, name)))
add(trees.length === 3 ? PASS : FAIL, 'layout', trees.length === 3 ? `${PKG} has mesh-build, mesh-stl, sim-core` : `missing: ${['mesh-build', 'mesh-stl', 'sim-core'].filter((n) => !trees.includes(n)).join(', ')}`, trees.length === 3 ? null : { action: 'install the package again (all three trees ship inside it)' })

const manifestPath = join(REPO, 'package.json')
let manifest = null
try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch { /* reported below */ }
const patch = manifest?.dsh?.bundle?.patch
add(patch && existsSync(join(REPO, patch)) ? PASS : FAIL, 'bundle', patch ? `${manifest.name}@${manifest.version} declares dsh.bundle.patch=${patch}` : 'package.json has no dsh.bundle.patch', patch ? null : { action: 'this is not the installable package root — install from the repository root or a release tarball' })

// 3. peer modules the plugins import at load time
const peers = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-skill', '@deepseek-ai/cordis']
const missingPeers = []
for (const peer of peers) {
  try { await import(peer); } catch { missingPeers.push(peer) }
}
add(missingPeers.length === 0 ? PASS : FAIL, 'peers', missingPeers.length === 0 ? 'dsh-tools, dsh-skill, cordis resolve' : `cannot resolve ${missingPeers.join(', ')}`, missingPeers.length === 0 ? null : { action: 'run the installer from a profile (`dsh plugin --profile <p> add …`); outside DSH these peers are not installed' })

// 4. card catalogue on disk
let cards = 0
for (const pkg of ['mesh-build', 'mesh-stl']) {
  const dir = join(PKG, pkg, 'data', 'hints')
  if (!existsSync(dir)) continue
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf8'))
      cards += Array.isArray(data) ? data.length : (data.cards?.length ?? 0)
    } catch { /* a broken card file is reported by the catalogue check, not here */ }
  }
}
add(cards >= 30 ? PASS : WARN, 'cards', `${cards} knowledge cards on disk`, cards >= 30 ? null : { action: 'reinstall — the card files ship with the package' })

// 5. project or portable mode
const findUp = (start, name, depth = 12) => {
  let dir = start
  for (let i = 0; i < depth; i += 1) {
    if (existsSync(join(dir, name))) return join(dir, name)
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}
const projectFile = findUp(process.cwd(), 'sim-project.json')
add(projectFile ? PASS : WARN, 'project', projectFile ?? `no sim-project.json above ${process.cwd()} — portable mode (workRoot .cache/sim, caseRoots ./cases)`, projectFile ? null : { action: 'nothing required; add sim-project.json to pin caseRoots, cores and OpenFOAM installs' })

// 6. OpenFOAM
const candidates = [
  process.env.MESH_BUILD_OPENFOAM_BASHRC,
  process.env.MESH_STL_OPENFOAM_BASHRC,
  '/usr/lib/openfoam/openfoam2512/etc/bashrc',
  join(homedir(), 'openfoam/etc/bashrc'),
].filter(Boolean)
let bashrc = candidates.find((file) => existsSync(file)) ?? null
if (!bashrc && projectFile) {
  try {
    const project = JSON.parse(readFileSync(projectFile, 'utf8'))
    for (const install of Object.values(project.foam?.installations ?? {})) {
      const file = typeof install === 'string' ? install : install?.bashrc
      if (file && existsSync(file)) { bashrc = file; break }
    }
  } catch { /* an unreadable project file is not a doctor failure */ }
}
if (!bashrc) {
  add(WARN, 'openfoam', 'no bashrc found — geometry and delivery still work, meshing does not', { action: 'set foam.installations in sim-project.json, pass openfoam:"<bashrc>" to a tool, or export MESH_BUILD_OPENFOAM_BASHRC' })
} else {
  const probe = run('bash', ['-lc', `source "${bashrc}" >/dev/null 2>&1; printf '%s|%s|' "$WM_PROJECT_VERSION" "$WM_PROJECT_DIR"; for t in blockMesh snappyHexMesh checkMesh cartesianMesh gmshToFoam; do command -v $t >/dev/null && printf "$t,"; done; printf '|'`])
  const [rawVersion, projectDir, tools] = probe.out.split('|')
  const version = String(rawVersion ?? '').replace(/^v/, '')
  const have = new Set((tools ?? '').split(',').filter(Boolean))
  const need = ['blockMesh', 'snappyHexMesh', 'checkMesh'].filter((tool) => !have.has(tool))
  add(need.length === 0 ? PASS : FAIL, 'openfoam', `${bashrc} → ${rawVersion} · ${projectDir} · ${[...have].join(', ') || 'no tools'}`, need.length === 0 ? null : { action: `install OpenFOAM.com or .org with ${need.join(', ')}` })
  if (!have.has('cartesianMesh')) add(WARN, 'cfmesh', 'cartesianMesh not installed (OpenFOAM.org builds never ship it)', { action: 'route:"snappy" works everywhere; cfMesh needs OpenFOAM.com' })
  if (!have.has('gmshToFoam')) add(WARN, 'gmsh', 'gmshToFoam not installed', { action: 'the gmsh route needs gmsh + gmshToFoam; skip it otherwise' })
}

// 7. python for the python generator families (a project venv wins over the system interpreter)
const findUpFile = (start, parts, depth = 4) => {
  let dir = start
  for (let i = 0; i < depth; i += 1) {
    const candidate = join(dir, ...parts)
    if (existsSync(candidate)) return candidate
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
  return null
}
const venvPython = findUpFile(process.cwd(), ['.venv', 'bin', 'python'])
const pythonCandidates = [process.env.MESH_PYTHON, venvPython, 'python3', 'python'].filter(Boolean)
let interpreter = null
for (const candidate of pythonCandidates) {
  const probe = candidate.includes('/') ? (existsSync(candidate) ? { ok: true, out: candidate } : { ok: false }) : run('bash', ['-lc', `command -v ${candidate} \|\| true`])
  if (probe.ok && probe.out) { interpreter = { command: probe.out.trim(), label: candidate.includes('/') ? probe.out.trim() : candidate }; break }
}
if (!interpreter) {
  add(WARN, 'python', 'no python3 on PATH', { action: 'only the python generator families need it; `primitive`, `box-array` and `stratified-channel` are pure JS' })
} else {
  const modules = run(interpreter.command, ['-c', 'import importlib.util as u; print(",".join(m for m in ("trimesh","numpy","scipy","skimage","cadquery") if u.find_spec(m)))'])
  const found = (modules.out || '').split(',').filter(Boolean)
  add(found.includes('trimesh') ? PASS : WARN, 'python', `${interpreter.label} · modules: ${found.join(', ') || 'none'}${venvPython && interpreter.command === venvPython ? ' (project venv)' : ''}`, found.includes('trimesh') ? null : { action: 'pip install trimesh numpy for the python families (JS families need nothing)' })
}

// 8. ParaView, optional but the only supported viewer
const pv = ['/opt/ParaView-6.2.1-MPI-Linux-Python3.12-x86_64/bin/pvpython', '/usr/bin/pvpython', '/usr/bin/paraview'].find((file) => existsSync(file))
add(pv ? PASS : WARN, 'paraview', pv ?? 'no pvpython/paraview found', pv ? null : { action: 'install ParaView to look at the result; delivery itself does not need it' })

const failed = rows.filter((row) => row.level === FAIL)
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: failed.length === 0, rows }, null, 2))
} else {
  for (const row of rows) {
    console.log(`${row.level.padEnd(4)} ${row.area.padEnd(9)} ${row.detail}`)
    if (row.fix) console.log(`     ${' '.repeat(9)} -> ${row.fix.action}`)
  }
  const warns = rows.filter((row) => row.level === WARN).length
  console.log(`\n${failed.length === 0 ? 'READY' : 'NOT READY'} — ${rows.length - failed.length - warns} pass, ${warns} warn, ${failed.length} fail`)
  if (failed.length === 0) console.log('Next: node scripts/demo.mjs   (geometry → mesh → gate → delivery, about 30 s)')
}
process.exit(failed.length === 0 ? 0 : 1)
