/**
 * mesh-build/lib/routes.js — data-driven mesh routes (data/engine.json).
 *
 * A route is an ordered list of shell steps with placeholders. Conditions are a
 * small closed vocabulary resolved at execution time, so most changes (new
 * command, new step, different order) never touch code.
 * @module mesh-build/lib/routes
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { displayPath, q, readJson, runBash, tail } from './common.js'

/** Load and validate the engine description. */
export function loadEngine(dataDir) {
  const file = join(dataDir, 'engine.json')
  const raw = readJson(file, 'engine.json')
  const routes = Array.isArray(raw.routes) ? raw.routes : []
  if (routes.length === 0) throw new Error('engine.json: routes[] is empty')
  for (const route of routes) {
    if (!route.id || !Array.isArray(route.steps)) throw new Error(`engine.json: route ${route.id ?? '<no id>'} needs id and steps[]`)
  }
  return { ...raw, routes, file }
}

/** Compact catalog for the no-route call. */
export function catalogRoutes(engine) {
  return engine.routes.map((route) => ({
    id: route.id,
    title: route.title,
    when: route.when,
    software: route.software,
    evidence: route.evidence ?? [],
    requires: route.requires ?? [],
    steps: route.steps.map((step) => step.name),
    failures: route.failures ?? [],
  }))
}

/** Placeholder context plus runtime flags. */
export function makeContext(config, args, caseDir) {
  return {
    caseDir,
    config,
    args,
    np: Math.max(1, Math.floor(Number(args.np) || config.np || 1)),
    msh: args.msh ? String(args.msh) : '',
    gmshScript: args.gmshScript ? String(args.gmshScript) : '',
    gmshArgs: Array.isArray(args.gmshArgs) ? args.gmshArgs.map(String) : [],
  }
}

function enabled(when, ctx) {
  const { args, np } = ctx
  switch (when ?? 'always') {
    case 'always': return true
    case 'blockMesh': return args.skipBlockMesh !== true
    case 'features': return args.features !== false && existsSync(join(ctx.caseDir, 'system', 'surfaceFeatureExtractDict'))
    case 'parallel': return np > 1
    case 'serial': return np <= 1
    case 'splitRegions': return args.splitRegions === true
    default: throw new Error(`engine.json: unknown step condition "${when}"`)
  }
}

/** Substitute placeholders in a command template. */
export function renderCommand(template, ctx) {
  return String(template).replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    switch (key) {
      case 'caseDir': return q(ctx.caseDir)
      case 'np': return String(ctx.np)
      case 'msh': return ctx.msh ? q(ctx.msh) : ''
      case 'python': return q(ctx.config.python)
      case 'gmshScript': return ctx.gmshScript ? q(ctx.gmshScript) : ''
      case 'gmshArgs': return ctx.gmshArgs.map((a) => q(a)).join(' ')
      default: throw new Error(`unknown route placeholder {${key}}`)
    }
  })
}

/** Steps that will run for this context (planning only, no execution). */
export function planRoute(route, ctx) {
  return route.steps
    .map((step, index) => ({ ...step, index: index + 1 }))
    .filter((step) => enabled(step.when, ctx))
}

/** Preflight: required dictionaries and files must exist before running. */
export function preflight(config, route, args, caseDir) {
  const problems = []
  if (route.id === 'check') {
    if (!existsSync(join(caseDir, 'constant'))) problems.push(`no constant/ in ${displayPath(config, caseDir)}`)
    return problems
  }
  if (args.skipBlockMesh !== true && route.id === 'snappy' && !existsSync(join(caseDir, 'system', 'blockMeshDict'))) {
    problems.push('missing system/blockMeshDict (needed unless skipBlockMesh:true)')
  }
  if (route.id === 'snappy' && !existsSync(join(caseDir, 'system', 'snappyHexMeshDict'))) {
    problems.push('missing system/snappyHexMeshDict')
  }
  if (route.id === 'cfmesh' && !existsSync(join(caseDir, 'system', 'meshDict'))) {
    problems.push('missing system/meshDict (cfMesh dictionary)')
  }
  if (route.id === 'gmsh') {
    if (!ctxGmsh(args)) problems.push('route gmsh needs gmshScript and msh')
  }
  return problems
}

function ctxGmsh(args) {
  return Boolean(args.gmshScript && args.msh)
}

/** Execute a route; returns step results and the failing step (if any). */
export function runRoute(config, route, args, caseDir) {
  const ctx = makeContext(config, args, caseDir)
  const logDir = join(caseDir, 'logs')
  mkdirSync(logDir, { recursive: true })
  const executed = []
  for (const step of planRoute(route, ctx)) {
    const command = renderCommand(step.run, ctx)
    const result = runBash(command, {
      cwd: caseDir,
      timeoutMs: Math.max(1000, Number(step.timeoutMs) || config.timeoutMs),
      openfoamBashrc: config.openfoamBashrc,
    })
    const logFile = join(logDir, `plugin-${route.id}-${String(step.index).padStart(2, '0')}-${step.name}.log`)
    writeFileSync(logFile, `$ ${command}\n\nexit code: ${result.code}\n\n--- stdout ---\n${result.stdout}\n--- stderr ---\n${result.stderr}\n`, 'utf8')
    const record = {
      name: step.name,
      command,
      code: result.code,
      durationMs: result.durationMs,
      log: displayPath(config, logFile),
      stdoutTail: tail(result.stdout, 1500),
      stderrTail: tail(result.stderr, 2500),
    }
    executed.push(record)
    if (result.code !== 0) {
      return { ok: false, failedStep: record, steps: executed, context: describeContext(ctx) }
    }
  }
  return { ok: true, steps: executed, context: describeContext(ctx) }
}

function describeContext(ctx) {
  return { np: ctx.np, msh: ctx.msh || null, gmshScript: ctx.gmshScript || null }
}
