/**
 * sim-core/lib/hints.js — the knowledge-card store shared by Sim plugins.
 *
 * A card is plain JSON (`data/hints/*.json`), so knowledge is added, corrected or
 * removed without touching code. The store is exposed as the optional `simHints`
 * service: the first plugin to load provides it, later plugins register into it.
 * @module sim-core/lib/hints
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REQUIRED = ['id', 'title', 'statement']

/** Load every hint card from a directory of JSON files. */
export function loadHints(dir, source = 'own') {
  const cards = []
  const errors = []
  if (!existsSync(dir)) return { cards, errors: [`hints directory not found: ${dir}`], files: [] }
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  for (const file of files) {
    const full = join(dir, file)
    try {
      const parsed = JSON.parse(readFileSync(full, 'utf8'))
      const list = Array.isArray(parsed) ? parsed : parsed.cards
      if (!Array.isArray(list)) throw new Error('expected an array or {cards:[...]}')
      for (const card of list) {
        const missing = REQUIRED.filter((key) => !card || !card[key])
        if (missing.length) {
          errors.push(`${file}: card without ${missing.join(', ')}`)
          continue
        }
        cards.push({
          ...card,
          file,
          source: card.source ?? source,
          topics: Array.isArray(card.topics) ? card.topics : [],
          appliesTo: Array.isArray(card.appliesTo) ? card.appliesTo : [],
          recipe: Array.isArray(card.recipe) ? card.recipe : [],
          evidence: Array.isArray(card.evidence) ? card.evidence : [],
          improves: Array.isArray(card.improves) ? card.improves : [],
          status: card.status ?? 'derived',
        })
      }
    } catch (error) {
      errors.push(`${file}: ${error.message}`)
    }
  }
  return { cards, errors, files }
}

function tokens(text) {
  return String(text ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}_.+-]+/u)
    .filter((t) => t.length >= 2)
}

/** Score one card against query tokens (field weights reflect usefulness). */
function scoreCard(card, query, queryTokens) {
  const title = card.title.toLowerCase()
  const id = card.id.toLowerCase()
  const topics = card.topics.join(' ').toLowerCase()
  const statement = String(card.statement).toLowerCase()
  const when = String(card.when ?? '').toLowerCase()
  const recipe = card.recipe.join(' ').toLowerCase()
  const evidence = card.evidence.join(' ').toLowerCase()
  const appliesTo = card.appliesTo.join(' ').toLowerCase()
  const haystack = `${title} ${id} ${topics} ${statement} ${when} ${recipe} ${evidence} ${appliesTo}`
  if (query && haystack.includes(query.toLowerCase())) {
    return 20 + (title.includes(query.toLowerCase()) ? 10 : 0)
  }
  let score = 0
  for (const token of queryTokens) {
    const stem = token.slice(0, Math.max(4, Math.min(6, token.length)))
    if (title.includes(token)) score += 6
    else if (title.includes(stem)) score += 4
    if (id.includes(token)) score += 5
    if (topics.includes(token)) score += 4
    if (topics.includes(stem)) score += 2
    if (appliesTo.includes(token)) score += 3
    if (statement.includes(token)) score += 3
    if (statement.includes(stem)) score += 1
    if (when.includes(token) || when.includes(stem)) score += 2
    if (recipe.includes(token) || recipe.includes(stem)) score += 1
    if (evidence.includes(token)) score += 2
  }
  return score
}

/** Search cards; returns full cards sorted by relevance. */
export function searchHints(cards, query, limit = 5) {
  const q = String(query ?? '').trim()
  if (!q) return { matches: [], query: q, total: cards.length }
  const queryTokens = tokens(q)
  const scored = cards
    .map((card) => ({ card, score: scoreCard(card, q, queryTokens) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.card.id.localeCompare(b.card.id))
  return {
    matches: scored.slice(0, limit).map((item) => ({ ...item.card, score: item.score })),
    total: scored.length,
    query: q,
  }
}

/** Catalog view: ids/titles grouped by topic and status, no long text. */
export function catalogHints(cards) {
  const byTopic = {}
  for (const card of cards) {
    const topics = card.topics.length ? card.topics : ['general']
    for (const topic of topics) {
      byTopic[topic] ??= []
      byTopic[topic].push({ id: card.id, title: card.title, status: card.status, source: card.source })
    }
  }
  const statuses = {}
  for (const card of cards) statuses[card.status] = (statuses[card.status] ?? 0) + 1
  return { count: cards.length, statuses, byTopic }
}

/** Short overview for the no-argument call. */
export function hintsOverview(cards, files, version) {
  return {
    version,
    hintCards: cards.length,
    hintFiles: files.length,
    statuses: cards.reduce((acc, c) => ({ ...acc, [c.status]: (acc[c.status] ?? 0) + 1 }), {}),
    topics: [...new Set(cards.flatMap((c) => c.topics))].sort(),
    sources: [...new Set(cards.map((c) => c.source ?? 'own'))].sort(),
    cards: cards.map((c) => ({ id: c.id, title: c.title, topics: c.topics, status: c.status, source: c.source })),
  }
}

/**
 * Create an empty hints store. Plugins call `registerDir()` for their own cards;
 * a plugin that finds `ctx.get('simHints')` registers into the existing store
 * instead of providing a competing one.
 */
export function createHintsStore(options = {}) {
  const cards = []
  const files = []
  const errors = []
  const sources = []
  let version = options.version ?? 1
  const seen = new Set()

  const api = {
    get version() { return version },
    set version(value) { version = Number(value) || version },
    register(list, source = 'own') {
      if (!Array.isArray(list)) throw new Error('hints register expects an array of cards')
      let added = 0
      for (const card of list) {
        if (!card || !card.id || seen.has(card.id)) continue
        seen.add(card.id)
        cards.push({ ...card, source: card.source ?? source })
        added += 1
      }
      if (added && !sources.includes(source)) sources.push(source)
      return { added, total: cards.length }
    },
    registerDir(dir, source = 'own') {
      const loaded = loadHints(dir, source)
      const added = api.register(loaded.cards, source)
      files.push(...loaded.files.map((file) => ({ file: join(dir, file), source })))
      errors.push(...loaded.errors)
      return { ...added, errors: loaded.errors, files: loaded.files }
    },
    search(query, limit = 5) { return searchHints(cards, query, limit) },
    catalog() { return catalogHints(cards) },
    overview() { return hintsOverview(cards, files, version) },
    get(id) { return cards.find((card) => card.id === id) ?? null },
    list() { return cards.map((card) => ({ ...card })) },
    stats() { return { version, cards: cards.length, files: files.length, sources: [...sources], errors: [...errors] } },
  }
  return api
}
