/**
 * mesh-build/lib/hints.js — compatibility facade over the sim-core hint store.
 *
 * Runtime knowledge goes through the `simHints` service; `loadHintsWithFallback`
 * stays for smoke scripts without a Cordis context.
 * @module mesh-build/lib/hints
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  catalogHints, createHintsStore, hintsOverview, loadHints, searchHints,
} from '../../sim-core/lib/hints.js'

export { catalogHints, hintsOverview, loadHints, searchHints }

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
