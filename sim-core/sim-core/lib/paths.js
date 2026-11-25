/**
 * sim-core/lib/paths.js — resolve user-supplied paths and report where they came from.
 *
 * Order: absolute -> cwd -> profile.caseRoots -> project root.
 * A miss is not silent: callers get `resolvedFrom`, the list of candidates and a
 * hint that names the file to edit (`sim-project.json`).
 * @module sim-core/lib/paths
 */
import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'

/**
 * @param {string} input path from the tool call
 * @param {{cwd?: string, projectRoot?: string, caseRootPaths?: string[]}} context
 * @returns {{dir: string, resolvedFrom: object, missing: boolean, hint?: string, candidates: string[]}}
 */
export function resolvePath(input, context = {}) {
  const raw = String(input ?? '')
  const cwd = context.cwd || process.cwd()
  const projectRoot = context.projectRoot || ''
  const roots = Array.isArray(context.caseRootPaths) ? context.caseRootPaths : []
  const candidates = []
  let kind = ''
  let root = ''
  let dir = ''

  if (isAbsolute(raw)) {
    dir = resolve(raw)
    kind = 'absolute'
  } else {
    const fromCwd = resolve(cwd, raw)
    candidates.push({ kind: 'cwd', root: cwd, dir: fromCwd })
    for (const caseRoot of roots) {
      candidates.push({ kind: 'caseRoot', root: caseRoot, dir: resolve(caseRoot, raw) })
    }
    if (projectRoot) candidates.push({ kind: 'projectRoot', root: projectRoot, dir: resolve(projectRoot, raw) })
    const hit = candidates.find((candidate) => existsSync(candidate.dir)) ?? candidates[0]
    ;({ kind, root, dir } = hit)
  }

  const missing = !existsSync(dir)
  const resolvedFrom = { kind, root, input: raw }
  const result = {
    dir,
    resolvedFrom,
    missing,
    candidates: candidates.map((candidate) => ({ kind: candidate.kind, root: candidate.root, dir: candidate.dir })),
  }
  if (missing) {
    result.hint = `path not found: ${dir}. Pass an absolute path, run from the directory that contains it, `
      + 'or add the containing root to "caseRoots" in sim-project.json (or set MESH_*_CASE_ROOTS / a config file).'
  }
  return result
}

/** Resolve and return only the directory (legacy helper used by generators). */
export function resolvePathString(input, context = {}) {
  return resolvePath(input, context).dir
}
