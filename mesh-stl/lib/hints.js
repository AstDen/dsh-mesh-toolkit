/**
 * mesh-stl/lib/hints.js — the knowledge cards bundled with the plugin.
 *
 * A card is plain JSON (data/hints/*.json), so knowledge can be added,
 * corrected or removed without touching code. Cards are the "hints" the agent
 * must consult before inventing STL/geometry rules.
 * @module mesh-stl/lib/hints
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const REQUIRED = ['id', 'title', 'statement']

/** Load every hint card from a directory of JSON files. */
export function loadHints(dir) {
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
          topics: Array.isArray(card.topics) ? card.topics : [],
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
  const haystack = `${title} ${id} ${topics} ${statement} ${when} ${recipe} ${evidence}`
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
      byTopic[topic].push({ id: card.id, title: card.title, status: card.status })
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
    cards: cards.map((c) => ({ id: c.id, title: c.title, topics: c.topics, status: c.status })),
  }
}
