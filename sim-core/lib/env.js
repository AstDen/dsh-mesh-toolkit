/**
 * sim-core/lib/env.js — OpenFOAM/Python environment discovery (portable defaults).
 * @module sim-core/lib/env
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pickPython } from './process.js'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Conventional system locations only; custom trees come from config/env
 * (`openfoamRoots` / `MESH_*_OPENFOAM_ROOTS`).
 */
export function detectOpenFoamBashrc(extraRoots = []) {
  const candidates = []
  const roots = [...extraRoots, '/usr/lib/openfoam', '/opt/openfoam', join(homedir(), 'openfoam')]
  for (const root of roots) {
    if (!root || !existsSync(root)) continue
    let entries = []
    try { entries = readdirSync(root) } catch { entries = [] }
    for (const entry of entries.sort().reverse()) {
      const candidate = join(root, entry, 'etc', 'bashrc')
      if (existsSync(candidate)) candidates.push(candidate)
    }
  }
  return candidates[0] ?? ''
}

/** Normalize a list/colon-string of OpenFOAM roots. */
export function normalizeRoots(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(':')
  return list.map((root) => String(root).trim()).filter(Boolean).map((root) => resolve(root))
}

/** Version on disk vs the version this process loaded (long-running DSH keeps the old one). */
export function versionInfo(dir = '', reported = '0.0.0') {
  if (!dir) return { reported, onDisk: null, stale: false }
  let onDisk = null
  try {
    onDisk = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null
  } catch { /* package.json unreadable — keep what we have */ }
  return {
    reported,
    onDisk,
    stale: Boolean(onDisk && onDisk !== reported),
    note: onDisk && onDisk !== reported
      ? `this process loaded ${reported} at start; package.json now says ${onDisk} — disable and re-enable the plugin to pick it up`
      : undefined,
  }
}

/** Read the version declared next to a plugin's lib/ directory. */
export function readPackageVersion(packageRoot) {
  try {
    return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

export { pickPython }
