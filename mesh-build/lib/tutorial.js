/**
 * mesh-build/lib/tutorial.js — run the installed OpenFOAM mesh tutorials as an oracle.
 *
 * The tutorials (`$WM_PROJECT_DIR/tutorials/mesh`) are the reference the project trusts: every
 * file shipped there is known to work with *that* build. This module reads a tutorial's `Allrun`
 * and replays its steps **without a shell**: the script is parsed into a small, closed set of
 * step kinds (run one whitelisted utility, copy/mkdir/remove/touch inside the copied case,
 * restore 0/ from 0.orig/, clear time directories), so a tutorial can never `rm -rf` outside the
 * case, never call an arbitrary binary and never run a solver when the caller asked for a mesh.
 *
 * Unknown shell constructs are not guessed: the case is reported as `manual` with the offending
 * line, which is the honest answer ("this tutorial needs a feature the parser does not have").
 *
 * @module mesh-build/lib/tutorial
 */
import {
  cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { q, runBash } from '../../sim-core/lib/process.js'
import { parseCheckMesh, verdictOf } from '../../sim-core/lib/checkmesh.js'
import { readCasePatches } from './patches.js'
import { gateCase } from './gate.js'

export const TUTORIAL_SCHEMA = 'mesh-tutorial/1'
export const TUTORIAL_STEP_SCHEMA = 'mesh-tutorial-step/1'

/**
 * Utilities a tutorial step may run. The list is deliberately explicit: a tutorial that calls
 * anything else is refused (fail-closed) instead of being executed through /bin/sh.
 * `solver: true` marks applications that solve rather than mesh — mesh-only mode stops before them.
 */
export const TUTORIAL_UTILS = {
  // meshers
  blockMesh: {}, snappyHexMesh: {}, cartesianMesh: {}, pMesh: {}, tetMesh: {},
  foamyHexMesh: {}, foamyQuadMesh: {}, PDRblockMesh: {}, polyDualMesh: {}, extrudeMesh: {},
  extrude2DMesh: {}, extrudeToRegionMesh: {},
  // moveDynamicMesh is a mesh-motion *solver*: it needs 0/ fields and, in tutorials that
  // use coded function objects, builds a dynamicCode library at run time (blockMesh/pipe:
  // "Could not load .../dynamicCode/.../librelaxationFactor_*.so" then SIGSEGV).
  // mesh-only therefore stops before it.
  moveDynamicMesh: { solver: true },
  // mesh manipulation
  topoSet: {}, setSet: {}, setsToZones: {}, subsetMesh: {}, createPatch: {}, createBaffles: {},
  createZones: {}, splitMeshRegions: {}, stitchMesh: {}, refineMesh: {}, refineWallLayer: {},
  mergeMeshes: {}, mergeOrSplitBaffles: {}, removeFaces: {}, renumberMesh: {}, checkMesh: {},
  changeDictionary: {}, transformPoints: {}, rotateMesh: {}, surfaceMeshTriangulate: {},
  // parallel
  decomposePar: {}, reconstructPar: {}, reconstructParMesh: {}, redistributePar: {},
  // surfaces / features
  surfaceFeatureExtract: {}, surfaceFeatures: {}, surfaceCheck: {}, surfaceOrient: {},
  surfaceRefineRedGreen: {}, surfaceTransformPoints: {}, surfaceRedistance: {},
  surfaceMeshExtract: {}, surfaceToVTK: {}, surfaceAdd: {}, surfaceBooleanFeatures: {},
  surfaceConvert: {}, surfaceInflate: {},
  // edge/face surgery used by the foamy* and blockMesh families
  collapseEdges: {}, refineHexMesh: {}, setFields: {}, postProcess: {},
  // dictionaries / listing (no mesh change)
  foamDictionary: {}, foamListTimes: {}, foamListRegions: {}, foamListTimesProcessor: {},
  // solvers (only with steps:"all")
  // reconstructs *fields* written by a solver; mesh-only has no time directories for it
  // (blockMesh/sphere7: `reconstructPar` -> 'FOAM Warning: No times selected', exit 1).
  reconstructPar: { fieldOnly: true },
  simpleFoam: { solver: true }, icoFoam: { solver: true }, pisoFoam: { solver: true },
  pimpleFoam: { solver: true }, rhoPimpleFoam: { solver: true }, buoyantSimpleFoam: { solver: true },
  interFoam: { solver: true }, chtMultiRegionFoam: { solver: true }, potentialFoam: { solver: true },
  scalarTransportFoam: { solver: true }, sonicFoam: { solver: true }, boundaryFoam: { solver: true },
  foamRun: { solver: true }, foamMultiRun: { solver: true },
}
/** Commands a tutorial may run through `$(...)` substitution. */
const SUBSTITUTIONS = new Set(['getApplication', 'foamListRegions', 'foamListTimes', 'foamDictionary', 'basename'])

const HELPERS = new Set(['restore0Dir', 'cleanTimeDirectories', 'cleanCase'])
const FILE_OPS = new Set(['mkdir', 'cp', 'mv', 'rm', 'touch', 'rmdir', 'ln'])
const IGNORED_PREFIXES = ['#!', '. ', 'cd "${0%/*}', 'cd "${0%/*}"', 'exit 0', 'echo ', 'export ', 'unset ']
const TUTORIAL_DIR = 'tutorials/mesh'

const cache = new Map()

/** Join continuation lines (`cp -f \\` + next line) keeping the first physical line number. */
export function joinContinuations(text) {
  const out = []
  let pending = null
  let pendingLine = 0
  for (const [index, rawLine] of String(text).split(/\r?\n/).entries()) {
    let line = rawLine
    if (pending !== null) {
      line = pending + ' ' + line.trim()
      pending = null
    } else {
      pendingLine = index + 1
    }
    if (/\\\s*$/.test(line)) {
      pending = line.replace(/\\\s*$/, '').trimEnd()
      continue
    }
    out.push({ text: line, line: pendingLine || index + 1 })
    pendingLine = 0
  }
  if (pending !== null) out.push({ text: pending, line: pendingLine })
  return out
}

/** Drop a trailing `# comment` that is not inside quotes; a leading `#` kills the whole line. */
export function stripComment(line) {
  const s = String(line)
  if (/^\s*#/.test(s)) return ''
  let quote = null
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]
    if (quote) {
      if (ch === quote) quote = null
      else if (ch === '\\' && quote === '"') i += 1
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
  }
  return s
}

/** Split a shell-ish line into words: quotes and `$(...)` are kept together. */
export function splitWords(line) {
  const words = []
  let word = null
  let quote = null
  let depth = 0
  const flush = () => {
    if (word !== null && word !== '') words.push(word)
    word = null
  }
  for (let i = 0; i < String(line).length; i += 1) {
    const ch = line[i]
    if (word === null) word = ''
    if (quote) {
      if (ch === quote) { quote = null; continue }
      if (ch === '\\' && quote === '"') { word += line[i + 1] ?? ''; i += 1; continue }
      word += ch
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '$' && line[i + 1] === '(') {
      depth = 1
      let inner = ''
      let j = i + 2
      for (; j < line.length && depth > 0; j += 1) {
        if (line[j] === '(') depth += 1
        else if (line[j] === ')') depth -= 1
        if (depth > 0) inner += line[j]
      }
      word += `$(${inner})`
      i = j - 1
      continue
    }
    if (/\s/.test(ch)) { flush(); continue }
    if (ch === '\\') { word += line[i + 1] ?? ''; i += 1; continue }
    word += ch
  }
  flush()
  return words
}

/** Read `application` from system/controlDict (the shell's `getApplication`). */
export function readApplication(caseDir, cwd = '.') {
  const file = join(caseDir, cwd, 'system', 'controlDict')
  if (!existsSync(file)) return null
  const hit = readFileSync(file, 'utf8').match(/^\s*application\s+([A-Za-z0-9_]+)\s*;/m)
  return hit ? hit[1] : null
}

/** Numeric time directories of a case (optionally inside processor*). */
export function timeDirectories(dir) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d+(\.\d+)?$/.test(entry.name))
    .map((entry) => entry.name)
}

/** `numberOfSubdomains` from decomposeParDict (shell's getNumberOfProcessors). */
export function readSubdomains(caseDir, dict = 'system/decomposeParDict') {
  const file = isAbsolute(dict) ? dict : join(caseDir, dict)
  if (!existsSync(file)) return null
  const hit = readFileSync(file, 'utf8').match(/^\s*numberOfSubdomains\s+(\d+)\s*;/m)
  return hit ? Number(hit[1]) : null
}

function assertInside(caseDir, target, what) {
  const root = resolve(caseDir)
  const abs = resolve(target)
  const rel = relative(root, abs)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) return abs
  throw new Error(`${what} escapes the case directory: ${abs}`)
}

/** Brace + glob expansion relative to the case (or an absolute path inside the tutorials tree). */
function expandPattern(pattern, { caseDir, tutorialsRoot }) {
  const braces = String(pattern).match(/\{([^{}]*)\}/)
  if (braces) {
    return braces[1].split(',').flatMap((part) => expandPattern(pattern.replace(braces[0], part), { caseDir, tutorialsRoot }))
  }
  const absolute = isAbsolute(pattern)
  const dir = absolute ? dirname(pattern) : dirname(pattern)
  const base = basename(pattern)
  if (!/[*?]/.test(base)) return [pattern]
  const absDir = absolute ? dir : join(caseDir, dir)
  if (!existsSync(absDir)) return []
  const regex = new RegExp(`^${base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`)
  return readdirSync(absDir).filter((name) => regex.test(name)).sort().map((name) => (absolute ? join(dir, name) : join(dir, name)))
}

/**
 * Parse an Allrun/Allrun.pre into declarative steps.
 * @returns {{steps: object[], manual: object[], utils: string[], solvers: string[]}}
 */
export function parseAllrun(text, context) {
  const { caseDir, tutorialsRoot: root, depth = 0 } = context
  const cwd = context.cwd ?? '.'
  const vars = new Map(Object.entries(context.vars ?? {}))
  // $FOAM_TUTORIALS is <project>/tutorials (the parent of the tutorials/mesh root we scan).
  vars.set('FOAM_TUTORIALS', dirname(root))
  vars.set('WM_PROJECT_DIR', dirname(dirname(dirname(root))))
  vars.set('PWD', join(caseDir, cwd))
  const steps = []
  const manual = []
  const utils = []
  const solvers = []
  const lines = joinContinuations(text)

  const fail = (entry, reason) => manual.push({ ...entry, reason, cwd })

  const expandValue = (value, entry) => {
    if (!String(value).includes('$')) return value
    return String(value).replace(/\$\(([^()]*)\)|\$\{(\w+)\}|\$(\w+|\*|\d)/g, (whole, subst, braced, plain) => {
      if (subst !== undefined) {
        const words = splitWords(subst)
        const util = words[0] ?? ''
        if (!SUBSTITUTIONS.has(util)) {
          fail(entry, `command substitution $(${subst}) is not in the closed substitution list`)
          return whole
        }
        if (util === 'getApplication') return readApplication(caseDir, cwd) ?? 'false'
        if (util === 'foamListRegions') {
          const regionsFile = join(caseDir, cwd, 'constant', 'regionProperties')
          if (!existsSync(regionsFile)) return ''
          const body = readFileSync(regionsFile, 'utf8')
          const groups = body.match(/\(\s*([A-Za-z0-9_]+)\s+[A-Za-z0-9_]+/g) ?? []
          return groups.map((g) => g.replace(/[()]/g, '').trim().split(/\s+/)[0]).join(' ')
        }
        if (util === 'basename') return basename(words[1] ?? '')
        if (util === 'foamDictionary') {
          // `foamDictionary -value -entry X file` is only used for echo/if in the tutorials.
          fail(entry, `command substitution $(${subst}) is informational only`)
          return ''
        }
        const dirs = timeDirectories(join(caseDir, cwd))
        if (/latestTime/.test(subst)) return dirs.sort((a, b) => Number(a) - Number(b)).pop() ?? ''
        return dirs.join(' ')
      }
      const name = braced ?? plain
      if (name === '*' || /^\d$/.test(name)) return ''
      if (!vars.has(name)) {
        fail(entry, `undefined shell variable $${name}`)
        return whole
      }
      return vars.get(name)
    })
  }

  for (let i = 0; i < lines.length; i += 1) {
    const entry = { line: lines[i].line, text: lines[i].text.trim() }
    const stripped = stripComment(lines[i].text).trim()
    if (!stripped) continue
    // `cd "${0%/*}" || exit` (com) and `cd ${0%/*} || exit 1` (org) only re-anchor the script.
    if (/^cd\s+["']?\$\{0%\/\*\}/.test(stripped)) continue
    if (IGNORED_PREFIXES.some((prefix) => stripped.startsWith(prefix))) continue
    if (/^\.\s/.test(stripped)) continue

    // heredoc: `setSet <<EOF ... EOF`
    const heredoc = stripped.match(/^(\w+)\s*(.*?)<<\s*'?([A-Za-z_][A-Za-z0-9_]*)'?\s*$/)
    if (heredoc) {
      const marker = heredoc[3]
      const body = []
      let closed = false
      let j = i + 1
      for (; j < lines.length; j += 1) {
        if (lines[j].text.trim() === marker) { closed = true; break }
        body.push(lines[j].text)
      }
      if (!closed) { fail(entry, `heredoc <<${marker} is not terminated`); continue }
      steps.push({ kind: 'run', util: heredoc[1], args: splitWords(expandValue(heredoc[2], entry)), cwd, stdin: `${body.join('\n')}\n`, line: entry.line, text: entry.text, parallel: false })
      utils.push(heredoc[1])
      i = j
      continue
    }

    // control flow: not interpreted — the case is reported as manual instead of guessing
    const flow = stripped.match(/^(if|for|while|case|until|select)\b/)
    if (flow) {
      const end = flow[1] === 'if' ? /^\s*fi\b/ : /^\s*done\b/
      let j = i + 1
      for (; j < lines.length; j += 1) if (end.test(lines[j].text)) break
      fail(entry, `shell control flow (${flow[1]}) is not interpreted by mesh_tutorial`)
      i = j
      continue
    }
    if (/^(wmake|canCompile|calcRadiusField|compileApplication)\b/.test(stripped)) {
      fail(entry, 'needs a compiler step; run this tutorial by hand')
      continue
    }

    // variable assignment — a form like `USE_ARC=true runApplication ...` is a command with an
    // environment prefix, not an assignment: the value of a real assignment has no unquoted space.
    const assign = stripped.match(/^([A-Za-z_][A-Za-z0-9_]*)=((?:['"][^'"]*['"]|\S*))$/)
    if (assign) {
      vars.set(assign[1], expandValue(assign[2].replace(/^(['"])(.*)\1$/, '$2'), entry))
      continue
    }

    // subshell: ( cd dir && command )
    const subshell = stripped.match(/^\(\s*cd\s+(\S+)\s*&&\s*(.+?)\s*\)$/)
    if (subshell) {
      const innerDir = subshell[1]
      const inner = subshell[2]
      const script = inner.match(/^\.\/(Allrun(?:\.pre)?)\s*(.*)$/)
      if (script) {
        const nestedDir = join(caseDir, cwd, innerDir)
        const file = join(nestedDir, script[1])
        if (!existsSync(file)) { fail(entry, `nested script not found: ${file}`); continue }
        const nested = parseAllrun(readFileSync(file, 'utf8'), {
          caseDir, tutorialsRoot: root, cwd: join(cwd, innerDir), vars: Object.fromEntries(vars), depth: depth + 1,
        })
        steps.push(...nested.steps)
        manual.push(...nested.manual.map((m) => ({ ...m, cwd: join(cwd, innerDir) })))
        utils.push(...nested.utils)
        continue
      }
      const nested = parseAllrun(inner, {
        caseDir, tutorialsRoot: root, cwd: join(cwd, innerDir), vars: Object.fromEntries(vars), depth: depth + 1,
      })
      steps.push(...nested.steps)
      manual.push(...nested.manual)
      utils.push(...nested.utils)
      continue
    }

    // `USE_ARC=true runApplication -s arc extrudeMesh`: RunFunctions forwards the variable through the
    // environment, so the step carries it explicitly instead of the whole line landing in `manual`.
    let commandLine = stripped
    const envs = {}
    for (;;) {
      const prefixed = commandLine.match(/^([A-Za-z_][A-Za-z0-9_]*)=(\S+)\s+(?=\S)/)
      if (!prefixed) break
      envs[prefixed[1]] = expandValue(prefixed[2].replace(/^(['"])(.*)\1$/, '$2'), entry)
      commandLine = commandLine.slice(prefixed[0].length)
    }
    const envField = Object.keys(envs).length ? { env: envs } : {}

    const words = splitWords(expandValue(commandLine, entry))
    if (!words.length) continue
    const head = words[0]

    if (head === 'runApplication' || head === 'runParallel') {
      let suffix = null
      let np = null
      let index = 1
      while (index < words.length) {
        const word = words[index]
        if (word === '-s' || word === '-suffix') { suffix = words[index + 1]; index += 2; continue }
        if (word === '-n' || word === '-np') { np = Number(words[index + 1]); index += 2; continue }
        if (word === '-a' || word === '-append' || word === '-o' || word === '-overwrite') { index += 1; continue }
        if (word === '-d' || word === '-directory' || word === '-p' || word === '-prefix') { index += 2; continue }
        if (/^-decompose(-ParDict|-dict)=/.test(word)) { index += 1; continue }
        if (word === '-decomposeParDict') { index += 2; continue }
        break
      }
      const util = words[index]
      if (!util) { fail(entry, `${head} without an application`); continue }
      const args = words.slice(index + 1)
      const parallel = head === 'runParallel'
      // `runApplication ./Allrun.pre` is a nested script, not an application: parse it in place.
      if (/^\.\/\w/.test(util)) {
        const file = join(caseDir, cwd, util)
        if (!existsSync(file)) { fail(entry, `nested script not found: ${file}`); continue }
        const nested = parseAllrun(readFileSync(file, 'utf8'), {
          caseDir, tutorialsRoot: root, cwd, vars: Object.fromEntries(vars), depth: depth + 1,
        })
        steps.push(...nested.steps)
        manual.push(...nested.manual)
        utils.push(...nested.utils)
        for (const solver of nested.solvers) solvers.push(solver)
        continue
      }
      if (!TUTORIAL_UTILS[util]) { fail(entry, `application "${util}" is not in the tutorial whitelist`); continue }
      if (TUTORIAL_UTILS[util].solver) solvers.push(util)
      steps.push({ kind: 'run', util, args, cwd, parallel, np, suffix, ...envField, line: entry.line, text: entry.text })
      utils.push(util)
      continue
    }

    if (FILE_OPS.has(head)) {
      const rest = words.slice(1)
      const flags = rest.filter((w) => w.startsWith('-'))
      const operands = rest.filter((w) => !w.startsWith('-'))
      const recursive = flags.some((f) => /r/i.test(f))
      if (head === 'mkdir') {
        steps.push({ kind: 'mkdir', dirs: operands, cwd, line: entry.line, text: entry.text })
      } else if (head === 'touch') {
        steps.push({ kind: 'touch', paths: operands, cwd, line: entry.line, text: entry.text })
      } else if (head === 'rmdir') {
        steps.push({ kind: 'remove', paths: operands, cwd, recursive: false, rmdir: true, line: entry.line, text: entry.text })
      } else if (head === 'rm') {
        const expanded = operands.flatMap((p) => expandPattern(p, { caseDir, tutorialsRoot: root, cwd }))
        steps.push({ kind: 'remove', paths: expanded, cwd, recursive, line: entry.line, text: entry.text })
      } else if (head === 'mv') {
        if (operands.length !== 2) { fail(entry, 'mv with more than two operands is not supported'); continue }
        steps.push({ kind: 'move', from: operands[0], to: operands[1], cwd, line: entry.line, text: entry.text })
      } else if (head === 'cp') {
        if (operands.length < 2) { fail(entry, 'cp needs a source and a destination'); continue }
        const sources = operands.slice(0, -1).flatMap((p) => expandPattern(p, { caseDir, tutorialsRoot: root, cwd }))
        steps.push({ kind: 'copy', sources, dest: operands[operands.length - 1], cwd, recursive, line: entry.line, text: entry.text })
      } else {
        fail(entry, `${head} is not supported by mesh_tutorial`)
      }
      continue
    }

    if (HELPERS.has(head)) {
      steps.push({ kind: head === 'restore0Dir' ? 'restore0' : 'cleanTimes', cwd, line: entry.line, text: entry.text })
      continue
    }

    if (head === 'foamListTimes') {
      if (words.includes('-rm')) steps.push({ kind: 'cleanTimes', cwd, line: entry.line, text: entry.text })
      else fail(entry, 'foamListTimes without -rm is informational only')
      continue
    }

    if (TUTORIAL_UTILS[head]) {
      // bare utility call (no runApplication wrapper)
      if (TUTORIAL_UTILS[head].solver) solvers.push(head)
      steps.push({ kind: 'run', util: head, args: words.slice(1), cwd, parallel: false, suffix: null, line: entry.line, text: entry.text })
      utils.push(head)
      continue
    }

    fail(entry, `unsupported shell line`)
  }

  return { steps, manual, utils, solvers }
}

/** Probe the tutorials root and utility availability of one OpenFOAM installation. */
export function probeTutorials(config) {
  const bashrc = config.openfoamBashrc ?? ''
  const key = bashrc || '(default)'
  if (cache.has(key)) return cache.get(key)
  const utils = Object.keys(TUTORIAL_UTILS)
  const script = [
    'printf "root=%s\\n" "$WM_PROJECT_DIR/tutorials/mesh"',
    'printf "project=%s\\n" "$WM_PROJECT_DIR"',
    'printf "version=%s\\n" "${WM_PROJECT_VERSION:-unknown}"',
    `for u in ${utils.join(' ')}; do if command -v "$u" >/dev/null 2>&1; then echo "have $u"; else echo "miss $u"; fi; done`,
  ].join('\n')
  const run = runBash(script, { cwd: config.projectRoot || process.cwd(), openfoamBashrc: bashrc, timeoutMs: 120000 })
  const root = (run.stdout.match(/^root=(.+)$/m) ?? [])[1] ?? ''
  const project = (run.stdout.match(/^project=(.+)$/m) ?? [])[1] ?? ''
  const version = (run.stdout.match(/^version=(.+)$/m) ?? [])[1] ?? ''
  const have = new Set([...run.stdout.matchAll(/^have (\S+)$/gm)].map((m) => m[1]))
  const available = {}
  for (const util of utils) available[util] = have.has(util)
  const result = {
    bashrc,
    project,
    version,
    root,
    exists: Boolean(root) && existsSync(root),
    available,
    missing: utils.filter((util) => !available[util]),
    probedAt: new Date().toISOString(),
    exitCode: run.code,
    stderrTail: run.stderr.slice(-2000),
  }
  cache.set(key, result)
  return result
}

/** Drop the probe cache (a refreshed binary set or a new bashrc must be re-read). */
export function clearTutorialCache() {
  cache.clear()
}

/** Directory names that never hold a nested tutorial case. */
const NON_CASE_DIRS = new Set(['constant', 'system', '0', '0.orig', 'logs', 'postProcessing', '.mesh-gate', 'dynamicCode', 'Make'])

/** Every case directory (a directory with system/controlDict) under one tutorials root. */
export function scanTutorialCases(root) {
  const cases = []
  const walk = (dir, depth, family) => {
    if (depth > 4 || !existsSync(dir)) return
    const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory())
    for (const entry of entries) {
      if (NON_CASE_DIRS.has(entry.name) || /^(processor|\.)/.test(entry.name) || /^\d+(\.\d+)?$/.test(entry.name)) continue
      const child = join(dir, entry.name)
      const fam = family ?? entry.name
      if (existsSync(join(child, 'system', 'controlDict'))) {
        const scripts = ['Allrun', 'Allmesh', 'Allrun.pre'].filter((f) => existsSync(join(child, f)))
        cases.push({
          id: relative(root, child).split('\\').join('/'),
          family: fam,
          dir: child,
          scripts,
        })
        // A case may contain sub-cases of its own (createPatch/TJunction.../inlet): keep walking.
        walk(child, depth + 1, fam)
        continue
      }
      walk(child, depth + 1, fam)
    }
  }
  walk(root, 1, null)
  return cases.sort((a, b) => a.id.localeCompare(b.id))
}

/** List tutorial cases of one installation with their parseability and utility requirements. */
export function listTutorials(config, { parse = true } = {}) {
  const probe = probeTutorials(config)
  if (!probe.exists) {
    return {
      ok: false,
      error: `tutorials root not found for ${probe.bashrc || 'the default installation'}`,
      probe,
      hint: 'source an OpenFOAM bashrc (or pass openfoam:"com2606") and retry',
    }
  }
  const cases = scanTutorialCases(probe.root).map((entry) => {
    const scriptFile = entry.scripts[0] ? join(entry.dir, entry.scripts[0]) : null
    const parsed = scriptFile && parse
      ? parseAllrun(readFileSync(scriptFile, 'utf8'), { caseDir: entry.dir, tutorialsRoot: probe.root })
      : { steps: [], manual: [], utils: [], solvers: [] }
    const missing = [...new Set(parsed.utils)].filter((util) => probe.available[util] === false)
    return {
      id: entry.id,
      family: entry.family,
      controlDict: join(entry.id, 'system/controlDict'),
      scripts: entry.scripts,
      stepCount: parsed.steps.length,
      utils: [...new Set(parsed.utils)],
      // `requires` is the plan's (PLAN-tutorial-2606 §7.2, T-00) name for the utilities a case
      // needs; keep it as the same list so the acceptance test reads the contract, not an alias.
      requires: [...new Set(parsed.utils)],
      solvers: [...new Set(parsed.solvers)],
      manual: parsed.manual,
      missingUtils: missing,
      runnable: parsed.manual.length === 0 && missing.length === 0,
    }
  })
  const families = {}
  for (const entry of cases) families[entry.family] = (families[entry.family] ?? 0) + 1
  return {
    ok: true,
    schema: TUTORIAL_SCHEMA,
    root: probe.root,
    bashrc: probe.bashrc,
    version: probe.version,
    counts: {
      cases: cases.length,
      controlDicts: cases.length,
      runnable: cases.filter((c) => c.runnable).length,
      manual: cases.filter((c) => c.manual.length > 0).length,
    },
    families,
    cases,
  }
}

function logLines(lines) {
  return lines.join('\n')
}

function writeStepLog(caseDir, name, { command, cwd, code, durationMs, stdout, stderr, timedOut, note }) {
  const dir = join(caseDir, 'logs')
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, logLines([
    `$ ${command}`,
    `cwd: ${cwd}`,
    `exit: ${code}${timedOut ? ' (timed out)' : ''}`,
    `durationMs: ${durationMs ?? ''}`,
    note ? `note: ${note}` : '',
    '--- stdout ---',
    stdout ?? '',
    '--- stderr ---',
    stderr ?? '',
    '',
  ]))
  return file
}

/** Remove every numeric time directory newer than 0 (shell `cleanTimeDirectories`). */
function cleanTimes(caseDir) {
  const removed = []
  for (const name of timeDirectories(caseDir)) {
    if (Number(name) === 0) continue
    rmSync(join(caseDir, name), { recursive: true, force: true })
    removed.push(name)
  }
  for (const entry of readdirSync(caseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^processor\d+$/.test(entry.name)) continue
    for (const name of timeDirectories(join(caseDir, entry.name))) {
      rmSync(join(caseDir, entry.name, name), { recursive: true, force: true })
      removed.push(`${entry.name}/${name}`)
    }
  }
  return removed
}

/** Execute one declarative file step; every path is confined to the case. */
function runFileStep(step, caseDir, foamTutorials) {
  const cwd = join(caseDir, step.cwd)
  const created = []
  const removed = []
  if (step.kind === 'mkdir') {
    for (const dir of step.dirs) {
      const target = assertInside(caseDir, join(cwd, dir), 'mkdir')
      mkdirSync(target, { recursive: true })
      created.push(relative(caseDir, target))
    }
  } else if (step.kind === 'touch') {
    for (const path of step.paths) {
      const target = assertInside(caseDir, join(cwd, path), 'touch')
      mkdirSync(dirname(target), { recursive: true })
      if (!existsSync(target)) writeFileSync(target, '')
      created.push(relative(caseDir, target))
    }
  } else if (step.kind === 'copy') {
    const destIsDir = step.dest.endsWith('/') || step.sources.length > 1
    for (const source of step.sources) {
      const absSource = isAbsolute(source) ? source : join(cwd, source)
      if (isAbsolute(source)) {
        const root = resolve(foamTutorials)
        const inside = relative(root, resolve(absSource))
        if (inside.startsWith('..') || isAbsolute(inside)) {
          throw new Error(`copy source outside the tutorials tree: ${source}`)
        }
      }
      if (!existsSync(absSource)) throw new Error(`copy source not found: ${source}`)
      const destBase = join(cwd, step.dest)
      const target = destIsDir || (existsSync(destBase) && statSync(destBase).isDirectory())
        ? join(destBase, basename(absSource))
        : destBase
      const safeTarget = assertInside(caseDir, target, 'copy')
      mkdirSync(dirname(safeTarget), { recursive: true })
      cpSync(absSource, safeTarget, { recursive: step.recursive || statSync(absSource).isDirectory(), dereference: true })
      created.push(relative(caseDir, safeTarget))
    }
  } else if (step.kind === 'move') {
    const from = assertInside(caseDir, join(cwd, step.from), 'mv source')
    const to = assertInside(caseDir, join(cwd, step.to), 'mv destination')
    if (!existsSync(from)) throw new Error(`mv source not found: ${step.from}`)
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
    created.push(relative(caseDir, to))
  } else if (step.kind === 'remove') {
    for (const path of step.paths) {
      const target = join(cwd, path)
      // A pattern that did not expand (no match) is not an error, like the shell.
      const abs = resolve(target)
      if (relative(resolve(caseDir), abs) === '') throw new Error('refusing to remove the case directory itself')
      const safe = assertInside(caseDir, abs, 'rm')
      if (!existsSync(safe)) continue
      rmSync(safe, { recursive: Boolean(step.recursive) || true, force: true })
      removed.push(relative(caseDir, safe))
    }
  } else if (step.kind === 'restore0') {
    const zero = join(caseDir, '0')
    const orig = join(caseDir, '0.orig')
    if (existsSync(zero)) { rmSync(zero, { recursive: true, force: true }); removed.push('0') }
    if (existsSync(orig)) { cpSync(orig, zero, { recursive: true }); created.push('0') }
  } else if (step.kind === 'cleanTimes') {
    removed.push(...cleanTimes(join(caseDir, step.cwd ?? '')))
  } else {
    throw new Error(`unknown file step: ${step.kind}`)
  }
  return { created, removed }
}

/** Build the concrete shell command for a run step (never a user-authored string). */
export function commandFor(step, { np, mpiOpts = '' }) {
  const util = step.util
  const args = (step.args ?? []).map((arg) => q(arg)).join(' ')
  const prefix = step.parallel
    ? `mpirun ${mpiOpts ? `${mpiOpts} ` : ''}-n ${np} ${util} -parallel`
    : util
  let command = `${prefix}${args ? ` ${args}` : ''}`
  if (step.stdin) command += ` <<'MESH_TUTORIAL_EOF'\n${step.stdin}MESH_TUTORIAL_EOF`
  return command
}

function stepLogName(index, step) {
  const suffix = step.suffix ? `_${String(step.suffix).replace(/^\./, '')}` : ''
  return `${String(index).padStart(2, '0')}${suffix}_${step.util ?? step.kind}.log`
}

const MPI_CACHE = new Map()

/**
 * Flags for mpirun. RunFunctions passes --oversubscribe for Open MPI only (it rejects the flag
 * elsewhere), so the flavour is detected from the installation rather than guessed from config.
 * Tutorials routinely decompose into more subdomains than the box has cores (8, 11, 16), and
 * without the flag Open MPI refuses to start: "There are not enough slots available".
 */
function mpiOptions(config) {
  const declared = String(config?.foam?.mpi ?? '')
  if (declared) return /open\s*mpi|openmpi/i.test(declared) ? '--oversubscribe' : ''
  const key = String(config?.openfoamBashrc ?? '')
  if (MPI_CACHE.has(key)) return MPI_CACHE.get(key)
  const probe = runBash('mpirun --version 2>&1 | head -3', {
    cwd: config?.projectRoot || process.cwd(),
    openfoamBashrc: key,
    timeoutMs: 30000,
  })
  const flavour = /open\s*mpi|openmpi/i.test(`${probe.stdout}\n${probe.stderr}`) ? '--oversubscribe' : ''
  MPI_CACHE.set(key, flavour)
  return flavour
}

/**
 * Run one tutorial case by replaying its Allrun.
 *
 * @param {object} config resolved plugin config (already bound to an installation)
 * @param {object} args {case, out, np, steps, force, timeoutMs, dryRun}
 */
export async function runTutorial(config, args) {
  const started = Date.now()
  const probe = probeTutorials(config)
  if (!probe.exists) {
    return { ok: false, error: `tutorials root not found for ${probe.bashrc || 'the default installation'}`, probe }
  }
  const caseId = String(args.case ?? '').replace(/^\/+|\/+$/g, '')
  if (!caseId) return { ok: false, error: 'case is required, e.g. case:"snappyHexMesh/flange"', available: 'mesh_tutorial({list:true})' }
  const sourceDir = join(probe.root, caseId)
  if (!existsSync(sourceDir)) {
    return { ok: false, error: `tutorial case not found: ${caseId}`, root: probe.root, available: 'mesh_tutorial({list:true})' }
  }
  const scripts = ['Allrun', 'Allmesh', 'Allrun.pre'].filter((f) => existsSync(join(sourceDir, f)))
  if (!scripts.length) return { ok: false, error: `no Allrun/Allmesh in ${caseId}` }
  const parsed = parseAllrun(readFileSync(join(sourceDir, scripts[0]), 'utf8'), { caseDir: sourceDir, tutorialsRoot: probe.root })
  const missing = [...new Set(parsed.utils)].filter((util) => probe.available[util] === false)
  if (missing.length) {
    return {
      ok: false,
      error: `this build is missing utilities the tutorial needs: ${missing.join(', ')}`,
      unsupported: missing,
      next: ['switch to an installation that ships them, e.g. openfoam:"com2606"', 'or mesh_tutorial({list:true}) to see what is runnable here'],
      manual: parsed.manual,
    }
  }

  const mode = Array.isArray(args.steps) ? 'explicit' : String(args.steps ?? 'mesh-only')
  const selection = Array.isArray(args.steps) ? args.steps.map(String) : null
  const candidate = parsed.steps
  if (!candidate.length) {
    return { ok: false, error: 'the Allrun produced no executable steps', manual: parsed.manual, case: caseId }
  }
  if (parsed.manual.length && !args.allowManual) {
    return {
      ok: false,
      error: `the Allrun uses shell constructs mesh_tutorial does not interpret (${parsed.manual.length})`,
      manual: parsed.manual,
      next: ['run this tutorial by hand, or extend mesh_tutorial with the missing construct'],
      case: caseId,
    }
  }

  // Steps to execute
  const steps = []
  const skipped = []
  for (const step of candidate) {
    if (step.kind !== 'run') { steps.push(step); continue }
    const spec = TUTORIAL_UTILS[step.util] ?? {}
    if (mode === 'mesh-only' && spec.solver) { skipped.push({ ...step, reason: 'solver (steps:"mesh-only")' }); continue }
    if (mode === 'mesh-only' && spec.fieldOnly) {
      skipped.push({ ...step, reason: 'field reconstruction, no solver times in "mesh-only"' })
      continue
    }
    if (selection && !selection.includes(step.util)) { skipped.push({ ...step, reason: 'not selected' }); continue }
    steps.push(step)
  }

  const outArg = String(args.out ?? `experiments/tut-${process.hrtime.bigint().toString().slice(-6)}_${caseId.replace(/\//g, '-')}`)
  const outDir = isAbsolute(outArg) ? outArg : resolve(config.projectRoot || process.cwd(), outArg)
  const insideRoots = [config.projectRoot, ...(config.caseRootPaths ?? [])].filter(Boolean).map((p) => resolve(p))
  if (insideRoots.length && !insideRoots.some((root) => {
    const rel = relative(root, outDir)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })) {
    return { ok: false, error: `out must stay inside the project: ${outDir}`, roots: insideRoots }
  }
  if (existsSync(outDir) && readdirSync(outDir).length && !args.force) {
    return { ok: false, error: `out is not empty: ${outDir}`, next: ['pass force:true to overwrite, or pick another out'] }
  }
  if (args.dryRun) {
    return {
      ok: true,
      dryRun: true,
      case: caseId,
      out: relative(config.projectRoot || process.cwd(), outDir),
      np: args.np ?? null,
      mode,
      steps: steps.map((step, i) => ({ ...step, log: stepLogName(i + 1, step) })),
      skipped: skipped.map((s) => ({ util: s.util, reason: s.reason, line: s.line })),
      manual: parsed.manual,
    }
  }

  if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true })
  mkdirSync(dirname(outDir), { recursive: true })
  cpSync(sourceDir, outDir, { recursive: true, dereference: true })

  const npDefault = readSubdomains(outDir) ?? 1
  const npRequested = Number.isFinite(Number(args.np)) && Number(args.np) > 0 ? Number(args.np) : npDefault
  // A parallel tutorial fixes its subdomain count in system/decomposeParDict (insidePoints: 6,
  // rotated_block: 5, sphere_gapClosure: 8). Running `mpirun -n 2` against that dict is a hard
  // FOAM FATAL ERROR ("specifies 6 processors but job was started with 2 ranks"), and rewriting
  // only numberOfSubdomains breaks hierarchical decomposition ("Wrong number of domain divisions").
  // Refuse instead of silently producing a different case than the tutorial.
  // Only a plan that actually starts `mpirun` depends on the subdomain count. Several tutorials keep a
  // decomposeParDict without ever running in parallel (extrudeMesh/faceZoneExtrusion declares 9), so a
  // serial plan simply ignores np instead of refusing a run that never forks.
  const needsParallel = steps.some((step) => step.parallel)
  if (needsParallel && npRequested !== npDefault) {
    return {
      ok: false,
      case: caseId,
      out: relative(config.projectRoot || process.cwd(), outDir),
      error: `${caseId} decomposes into ${npDefault} subdomains (system/decomposeParDict); refusing to run with np=${npRequested}`,
      np: npRequested,
      npFromDecomposeParDict: npDefault,
    // Set when the mesher stores its result in a time directory (foamyHexMesh) and it had to be
    // promoted to constant/polyMesh before the gate; the tutorial's own checkMesh used -latestTime.
    meshFromTimeDir: meshFrom,
      next: [`rerun with np=${npDefault}`, 'or edit system/decomposeParDict in a copy of the case (method + n)'],
    }
  }
  const npEffective = needsParallel ? npRequested : 1
  const mpiOpts = mpiOptions(config)
  const timeoutMs = Number(args.timeoutMs ?? config.timeoutMs ?? 1800000)
  const executed = []
  let failedStep = null
  const failedSteps = []
  const keepGoing = Boolean(args.keepGoing)

  for (const [index, step] of steps.entries()) {
    const n = index + 1
    const logName = stepLogName(n, step)
    if (step.kind !== 'run') {
      const stepStarted = Date.now()
      let outcome = { created: [], removed: [] }
      let error = null
      try {
        // copies may come from the whole tutorials tree ($FOAM_TUTORIALS/resources), not only tutorials/mesh
        outcome = runFileStep(step, outDir, dirname(probe.root))
      } catch (caught) {
        error = caught.message
      }
      const log = writeStepLog(outDir, logName, {
        command: step.text,
        cwd: step.cwd ?? '.',
        code: error ? 1 : 0,
        durationMs: Date.now() - stepStarted,
        stdout: `created: ${outcome.created.join(', ')}`,
        stderr: `removed: ${outcome.removed.join(', ')}${error ? `\nerror: ${error}` : ''}`,
      })
      executed.push({ n, kind: step.kind, text: step.text, cwd: step.cwd ?? '.', exit: error ? 1 : 0, error, log: relative(outDir, log) })
      if (error) {
        failedStep = { n, kind: step.kind, text: step.text, error }
        // Tutorials are plain sh scripts without `set -e`: a failing step does not stop the Allrun.
        if (!keepGoing) break
      }
      continue
    }
    const np = step.np ?? npEffective
    // A leading `VAR=value` in Allrun (`USE_ARC=true runApplication -s arc extrudeMesh`) belongs to the
    // environment of that one command; keep it visible in the log line and pass it to the shell.
    const envPrefix = step.env ? `${Object.entries(step.env).map(([k, v]) => `${k}=${v}`).join(' ')} ` : ''
    const command = envPrefix + commandFor(step, { np, mpiOpts })
    const stepStarted = Date.now()
    const run = runBash(command, {
      cwd: join(outDir, step.cwd ?? '.'),
      openfoamBashrc: config.openfoamBashrc,
      timeoutMs,
      env: step.env ?? {},
      maxBuffer: 256 * 1024 * 1024,
    })
    const log = writeStepLog(outDir, logName, {
      command,
      cwd: step.cwd ?? '.',
      code: run.code,
      durationMs: run.durationMs,
      timedOut: run.timedOut,
      stdout: run.stdout,
      stderr: run.stderr,
    })
    executed.push({
      n,
      schema: TUTORIAL_STEP_SCHEMA,
      kind: 'run',
      util: step.util,
      args: step.args,
      cwd: step.cwd ?? '.',
      parallel: Boolean(step.parallel),
      np: step.parallel ? np : null,
      suffix: step.suffix ?? null,
      command,
      exit: run.code,
      timedOut: Boolean(run.timedOut),
      durationMs: run.durationMs,
      log: relative(outDir, log),
      line: step.line,
    })
    if (run.code !== 0 || run.timedOut) {
      const tail = `${run.stdout}\n${run.stderr}`.trim().split('\n').slice(-40).join('\n')
      const failure = {
        n, util: step.util, line: step.line, exit: run.code, timedOut: Boolean(run.timedOut),
        log: relative(outDir, log), tail,
      }
      failedStep ??= failure
      failedSteps.push(failure)
      // A tutorial may deliberately run a step that exits non-zero (motorBike_leakDetection's first
      // snappy pass writes leakPath and exits on the detected leak); `--keep-going` mirrors the
      // Allrun's absence of `set -e` instead of forcing a wrapper around the tutorial.
      if (!keepGoing) break
    }
  }

  // Metrics: the gate parses checkMesh text and never changes the mesh (overlay only).
  let gate = null
  let metrics = null
  let patches = null
  // foamyHexMesh writes the mesh into time directories (blob: 80 → 81 → 82 after collapseEdges) and
  // its own checkMesh runs with -latestTime, so constant/polyMesh stays empty. Promote the latest
  // time-directory mesh so the gate judges the same mesh the tutorial just checked.
  let meshFrom = null
  const hasConstantMesh = existsSync(join(outDir, 'constant', 'polyMesh', 'faces'))
  if (!hasConstantMesh) {
    const timeDirs = readdirSync(outDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9]+(\.[0-9]+)?$/.test(entry.name))
      .map((entry) => entry.name)
      .filter((name) => existsSync(join(outDir, name, 'polyMesh', 'faces')))
      .sort((a, b) => Number(a) - Number(b))
    const latest = timeDirs.at(-1)
    if (latest) {
      const target = join(outDir, 'constant', 'polyMesh')
      if (existsSync(target)) rmSync(target, { recursive: true, force: true })
      cpSync(join(outDir, latest, 'polyMesh'), target, { recursive: true })
      meshFrom = latest
    }
  }

  if (existsSync(join(outDir, 'constant', 'polyMesh')) || existsSync(join(outDir, 'constant', 'polyMesh', 'points'))) {
    try {
      // Tutorial cases are an oracle, not project geometry: the template profile `gate` is the
      // default, because the project profile (minVolRatio 0.05) is tuned for our porous meshes and
      // fails tutorials on volume ratio alone (flange: 48 faces < 0.05, PASS under `gate`).
      const profile = args.profile ?? 'gate'
      gate = gateCase(config, outDir, { profile, minVol: args.minVol ?? null })
      metrics = gate?.results?.[0]?.metrics ?? null
      patches = readCasePatches(outDir)
    } catch (error) {
      gate = { verdict: 'ERROR', error: error.message }
    }
  } else if (!failedStep) {
    gate = { verdict: 'UNKNOWN', error: 'no constant/polyMesh after the run' }
  }

  const finished = Date.now()
  const manifest = {
    schema: TUTORIAL_SCHEMA,
    case: caseId,
    source: sourceDir,
    out: outDir,
    openfoam: {
      bashrc: probe.bashrc,
      project: probe.project,
      version: probe.version,
    },
    mode,
    np: npEffective,
    npFromDecomposeParDict: npDefault,
    // Set when the mesher stores its result in a time directory (foamyHexMesh) and it had to be
    // promoted to constant/polyMesh before the gate; the tutorial's own checkMesh used -latestTime.
    meshFromTimeDir: meshFrom,
    steps: executed,
    skipped: skipped.map((s) => ({ util: s.util, reason: s.reason, line: s.line, text: s.text })),
    manual: parsed.manual,
    failedStep,
    failedSteps,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationSec: Number(((finished - started) / 1000).toFixed(1)),
    // With --keep-going there can be failed steps yet a usable mesh: the gate then decides the
    // verdict and the failures stay visible in `failedSteps` instead of hiding a working mesh.
    verdict: gate?.verdict ?? (failedSteps.length ? 'FAILED' : 'UNKNOWN'),
    mesh: {
      cells: metrics?.cells ?? null,
      points: metrics?.points ?? null,
      faces: metrics?.faces ?? null,
      maxNonOrtho: metrics?.maxNonOrtho ?? null,
      maxSkewness: metrics?.maxSkewness ?? null,
      minVolume: metrics?.minVolume ?? null,
      failedChecks: metrics?.failedChecks ?? null,
      meshOk: metrics?.meshOk ?? null,
      regions: gate?.regions ?? patches?.entries?.map((e) => e.region).filter((r) => r !== null) ?? [],
      patches: (patches?.entries ?? []).flatMap((entry) => (entry.patches ?? []).map((p) => ({ ...p, region: entry.region ?? null }))),
    },
    gate: gate ? {
      profile: gate.results?.[0]?.profile ?? args.profile ?? 'gate',
      verdict: gate.verdict,
      pass: gate.pass ?? null,
      logs: (gate.results ?? []).map((r) => r.log).filter(Boolean),
      advisory: [...new Set((gate.results ?? []).flatMap((r) => r.advisory ?? []))],
      error: gate.error ?? null,
    } : null,
  }
  writeFileSync(join(outDir, 'tutorial-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return {
    ok: Boolean(gate?.pass) || (!failedSteps.length && !failedStep),
    case: caseId,
    out: relative(config.projectRoot || process.cwd(), outDir),
    verdict: manifest.verdict,
    cells: manifest.mesh.cells,
    maxNonOrtho: manifest.mesh.maxNonOrtho,
    patches: manifest.mesh.patches.length,
    durationSec: manifest.durationSec,
    stepsRun: executed.filter((s) => s.kind === 'run').length,
    stepsSkipped: skipped.length,
    failedStep,
    failedSteps,
    manifest: relative(config.projectRoot || process.cwd(), join(outDir, 'tutorial-manifest.json')),
    logs: relative(config.projectRoot || process.cwd(), join(outDir, 'logs')),
    gate: manifest.gate,
  }
}

/**
 * Verify a tutorial mesh against a baseline manifest: cells ±tolerance, same patches,
 * maxNonOrtho within ±degrees (plan T-11).
 */
export function compareTutorialManifest(baseline, current, { cellsTolerance = 0.05, nonOrthoTolerance = 2 } = {}) {
  const problems = []
  if (!baseline?.mesh || !current?.mesh) return { ok: false, problems: ['one of the manifests has no mesh block'] }
  const rel = (a, b) => (a === null || b === null || Number(b) === 0 ? null : Math.abs(a - b) / Math.abs(b))
  const cellDelta = rel(current.mesh.cells, baseline.mesh.cells)
  if (cellDelta === null || cellDelta > cellsTolerance) {
    problems.push(`cells ${current.mesh.cells} vs baseline ${baseline.mesh.cells} (${cellDelta === null ? 'n/a' : `${(cellDelta * 100).toFixed(2)}%`} > ${(cellsTolerance * 100).toFixed(0)}%)`)
  }
  const nO = current.mesh.maxNonOrtho
  const bO = baseline.mesh.maxNonOrtho
  if (Number.isFinite(nO) && Number.isFinite(bO) && Math.abs(nO - bO) > nonOrthoTolerance) {
    problems.push(`maxNonOrtho ${nO} vs baseline ${bO} (Δ ${Math.abs(nO - bO).toFixed(2)}° > ${nonOrthoTolerance}°)`)
  }
  const patchNames = (list) => (list ?? []).map((p) => p.name).sort().join(',')
  if (patchNames(current.mesh.patches) !== patchNames(baseline.mesh.patches)) {
    problems.push(`patches differ: [${patchNames(current.mesh.patches)}] vs [${patchNames(baseline.mesh.patches)}]`)
  }
  return { ok: problems.length === 0, problems, cellsDelta: cellDelta, nonOrthoDelta: Number.isFinite(nO) && Number.isFinite(bO) ? Number((nO - bO).toFixed(3)) : null }
}

export { parseCheckMesh, verdictOf }
