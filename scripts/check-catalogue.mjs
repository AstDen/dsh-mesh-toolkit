#!/usr/bin/env node
// Catalogue sanity for the knowledge cards.
//
// Every card must be loadable, carry an id/title/statement, non-empty topics and
// evidence, and use a known status. Ids must be unique INSIDE a package. A few
// ids are deliberately shared between mesh-stl and mesh-build (mesh-stl ships a
// copy of the snappy cards); the merged catalogue collapses them at runtime, so
// cross-package duplicates are reported, not rejected.
//
// Exit 0 = catalogue OK, exit 1 = problems (printed to stderr).
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['mesh-stl', 'mesh-build']
const STATUSES = new Set(['verified', 'derived', 'unverified'])
const ID = /^[a-z0-9][a-z0-9-]*$/

const problems = []

function cardsOf(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'))
  if (Array.isArray(data)) return data
  if (data && Array.isArray(data.cards)) return data.cards
  throw new Error('expected an array of cards or { "cards": [ ... ] }')
}

const idsByPackage = new Map()

for (const pkg of PACKAGES) {
  const dir = join(ROOT, pkg, 'data', 'hints')
  if (!existsSync(dir)) {
    problems.push(`${pkg}: no data/hints directory`)
    continue
  }
  const files = readdirSync(dir).filter((name) => name.endsWith('.json')).sort()
  const ids = new Map()
  let cardsTotal = 0

  for (const name of files) {
    let cards
    try {
      cards = cardsOf(join(dir, name))
    } catch (error) {
      problems.push(`${pkg}/${name}: ${error.message}`)
      continue
    }
    cards.forEach((card, index) => {
      const where = `${pkg}/${name}[${index}]`
      const id = card?.id
      if (typeof id !== 'string' || !ID.test(id)) problems.push(`${where}: bad id ${JSON.stringify(id)}`)
      if (typeof card?.title !== 'string' || card.title.trim() === '') problems.push(`${where}: empty title`)
      if (typeof card?.statement !== 'string' || card.statement.trim() === '') problems.push(`${where}: empty statement`)
      if (!Array.isArray(card?.topics) || card.topics.length === 0) problems.push(`${where}: topics must be a non-empty array`)
      if (!Array.isArray(card?.evidence) || card.evidence.length === 0) problems.push(`${where}: evidence must be a non-empty array`)
      if (card?.status !== undefined && !STATUSES.has(card.status)) problems.push(`${where}: unknown status ${JSON.stringify(card.status)}`)
      if (typeof id !== 'string') return
      if (ids.has(id)) problems.push(`${where}: duplicate id "${id}" (also in ${ids.get(id)})`)
      else ids.set(id, name)
    })
    cardsTotal += cards.length
  }

  idsByPackage.set(pkg, ids)
  console.log(`${pkg}: ${ids.size} cards in ${files.length} files (${cardsTotal} entries)`)
}

const [left, right] = PACKAGES.map((pkg) => idsByPackage.get(pkg) ?? new Map())
const shared = [...left.keys()].filter((id) => right.has(id))
if (shared.length > 0) {
  console.log(`shared across packages (collapsed by the merged catalogue): ${shared.length} — ${shared.join(', ')}`)
}
console.log(`merged catalogue: ${new Set([...left.keys(), ...right.keys()]).size} unique cards`)

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`)
  for (const problem of problems) console.error(' -', problem)
  process.exit(1)
}
console.log('catalogue OK')
