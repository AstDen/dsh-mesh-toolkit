/**
 * mesh-stl/lib/hints.js — compatibility facade over the sim-core hint store.
 *
 * The runtime path is the `simHints` service (`ensureHints` in index.js): every plugin
 * registers its own directory into one shared store, so no plugin reads another
 * plugin's files by relative path. `loadHintsWithFallback` remains for smoke scripts
 * that run without a Cordis context.
 * @module mesh-stl/lib/hints
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  catalogHints, createHintsStore, hintsOverview, loadHints, searchHints,
} from '../../sim-core/lib/hints.js'

export { catalogHints, hintsOverview, loadHints, searchHints }

/**
 * Load own cards plus a sibling's cards (smoke-test helper only).
 * @param {string} primaryDir
 * @param {{dir: string, label: string}} [fallback]
 */
export function loadHintsWithFallback(primaryDir, fallback = null) {
  const store = createHintsStore()
  const own = store.registerDir(primaryDir, 'own')
  const files = [{ dir: primaryDir, source: 'own' }]
  const sources = ['own']
  let borrowed = 0
  if (fallback && existsSync(fallback.dir)) {
    const before = store.stats().cards
    store.registerDir(join(fallback.dir), fallback.label)
    borrowed = store.stats().cards - before
    files.push({ dir: fallback.dir, source: fallback.label })
    sources.push(fallback.label)
  }
  return {
    cards: store.list(),
    errors: own.errors,
    files: files.map((entry) => entry.dir).flatMap((dir) => (existsSync(dir) ? [dir] : [])),
    sources,
    borrowed,
  }
}
