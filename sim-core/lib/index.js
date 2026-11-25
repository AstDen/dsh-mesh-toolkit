/**
 * sim-core — shared foundation for the Sim plugin family.
 *
 * It knows nothing about a particular project's physics: config layering, project
 * profiles, path resolution, process execution, knowledge cards, checkMesh parsing,
 * the quality gate and artifact passports. Private to the package family; it is
 * imported by relative path (`../sim-core/lib/...`) and is never installed on its own.
 * @module sim-core
 */
export * as util from './util.js'
export * as process from './process.js'
export * as env from './env.js'
export * as paths from './paths.js'
export * as project from './project.js'
export * as config from './config.js'
export * as hints from './hints.js'
export * as checkmesh from './checkmesh.js'
export * as gate from './gate.js'
export * as passport from './passport.js'

import { readPackageVersion } from './env.js'
import { createHintsStore } from './hints.js'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const LIB_DIR = dirname(fileURLToPath(import.meta.url))
export const CORE_ROOT = dirname(LIB_DIR)
export const CORE_VERSION = readPackageVersion(CORE_ROOT)

/** Capability versions contributed or consumed through Cordis. */
export const CAPABILITIES = {
  simHints: 1,
  simGeometry: 1,
  simMesh: 1,
}

/**
 * Get or provide the shared hints service.
 *
 * The first plugin to start creates the store and provides `simHints`; every later
 * plugin registers its own `data/hints` into it, so no plugin reads another
 * plugin's files by relative path.
 *
 * @param {object} ctx Cordis context (needs `.get` and `.provide`)
 * @param {object} options
 * @param {string} options.owner plugin name, recorded as the card source
 * @param {string[]} options.dirs hint directories of this plugin
 * @param {number} [options.capabilityVersion]
 */
export function ensureHints(ctx, { owner, dirs = [], capabilityVersion = CAPABILITIES.simHints }) {
  let store = ctx.get('simHints')
  let provided = false
  if (!store) {
    store = createHintsStore({ version: capabilityVersion })
    try {
      ctx.provide('simHints', store)
      provided = true
    } catch {
      // Another fiber won the race; use the winner.
      store = ctx.get('simHints') ?? store
    }
  }
  const registered = []
  for (const dir of dirs) {
    try {
      registered.push({ dir, ...store.registerDir(dir, owner) })
    } catch (error) {
      registered.push({ dir, error: error.message })
    }
  }
  return { store, provided, registered }
}

/**
 * Provide a capability service once (get-then-provide, race tolerant).
 * Returns the active service, which may be the one provided by another plugin.
 */
export function provideService(ctx, name, api) {
  const existing = ctx.get(name)
  if (existing) return { service: existing, provided: false }
  try {
    ctx.provide(name, api)
    return { service: api, provided: true }
  } catch {
    return { service: ctx.get(name) ?? null, provided: false }
  }
}

/** Read an optional capability service, or null when its owner is not installed. */
export function service(ctx, name) {
  try { return ctx.get(name) ?? null } catch { return null }
}

/** Payload used when an optional capability is missing: names the package to install. */
export function missingServicePayload(name, consumer, hint) {
  return {
    available: false,
    service: name,
    consumer,
    reason: `capability "${name}" is not available: no plugin providing it is installed`,
    hint: hint ?? `Install the package that provides ${name} (e.g. mesh-stl for simGeometry, mesh-build for simMesh).`,
  }
}

/** Absolute path of a bundled data file. */
export function coreFile(...parts) {
  return join(CORE_ROOT, ...parts)
}
