// TW-12: the tutorial hint cards are part of the plugin contract — they must lint,
// keep a verified status and point at real evidence (a file:line in this repository).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHints, searchHints } from '../../sim-core/lib/hints.js'

const here = dirname(fileURLToPath(import.meta.url))
const hintsDir = join(here, '..', 'data', 'hints')
const projectRoot = join(here, '..', '..', '..')

test('hint files lint without errors and carry the tutorial topic', () => {
  const { cards, errors, files } = loadHints(hintsDir)
  assert.deepEqual(errors, [], `hint lint errors: ${JSON.stringify(errors)}`)
  assert.ok(files.some((f) => f.includes('tutorial-2606')))
  const mine = cards.filter((c) => c.file.includes('tutorial-2606'))
  assert.equal(mine.length, 16, 'expected sixteen tutorial-2606 cards (PLAN-tutorial-2606 TW-12)')
  for (const card of mine) {
    assert.equal(card.status, 'verified', `${card.id}: status must be verified`)
    assert.ok(card.evidence.length > 0, `${card.id}: evidence is required`)
    assert.ok(card.statement.length > 40, `${card.id}: statement is too thin`)
    assert.ok(card.recipe.length >= 2, `${card.id}: at least two recipe steps`)
  }
})

// The same test file ships in two layouts: the project tree (`plugins/mesh-build/...`,
// `env/openfoam/...`, `experiments/...`) and the published single package (`mesh-build/...`
// only). Evidence has to resolve in the layout it was written for; a path into the project's
// `env/`, `experiments/` or `benchmark/` trees is tolerated in a package-only checkout, where
// those trees do not exist at all. Nothing is tolerated where they do exist.
const packageRoot = join(here, '..')
const externalTops = ['env', 'experiments', 'benchmark']
const hasProjectTrees = externalTops.every((d) => existsSync(join(projectRoot, d)))

function evidenceCandidates(path) {
  const stripped = path.replace(/^plugins\//, '')
  return [
    join(projectRoot, path),
    join(projectRoot, stripped),
    join(packageRoot, stripped.replace(/^mesh-build\//, '')),
    join(packageRoot, stripped.replace(/^sim-core\//, '')),
    join(projectRoot, 'env/openfoam/com2606/usr/lib/openfoam/openfoam2606/tutorials/mesh', path),
    join(projectRoot, 'env/openfoam/org14/opt/openfoam14/tutorials/mesh', path),
  ]
}

test('every evidence line names a repository file that exists', () => {
  const { cards } = loadHints(hintsDir)
  const mine = cards.filter((c) => c.file.includes('tutorial-2606'))
  const missing = []
  const external = []
  for (const card of mine) {
    for (const line of card.evidence) {
      // evidence format: "<path>[:line[-line]] — <note>" or "<note> — <path…>"
      const match = line.match(/((?:[\w./-]+\/)?[\w.-]+\.(?:json|mjs|js|md|H|C|dict|txt|Dict|Allrun|sh)(?::\d+(?:-\d+)?)?)/)
      if (!match) continue
      const path = match[1].split(':')[0]
      if (evidenceCandidates(path).some((c) => existsSync(c))) continue
      if (!hasProjectTrees && externalTops.includes(path.split('/')[0])) {
        external.push(`${card.id}: ${path}`)
        continue
      }
      missing.push(`${card.id}: ${path}`)
    }
  }
  assert.deepEqual(missing, [], `evidence paths that do not resolve: ${missing.join('; ')}`)
  if (external.length) {
    console.warn(`external evidence not checked in a package-only checkout (${external.length}): ${external.join('; ')}`)
  }
})

test('search finds the card that owns a fact', () => {
  const { cards } = loadHints(hintsDir)
  const cases = [
    ['gapLevel org14', 'snappy-gaplevel-both-flavours'],
    ['writeFields overlay', 'checkmesh-writefields-copies-zero'],
    ['np decomposeParDict serial', 'tutorial-np-vs-decomposepardict'],
    ['USE_ARC extrude env prefix', 'tutorial-allrun-env-prefix'],
  ]
  for (const [query, expected] of cases) {
    const { matches } = searchHints(cards, query, 3)
    assert.ok(matches.length > 0, `no hits for ${query}`)
    assert.equal(matches[0].id, expected, `${query} -> ${matches.map((m) => m.id).join(', ')}`)
  }
})

test('the tutorial data stays consistent with the cards', () => {
  const manifest = JSON.parse(readFileSync(join(here, '..', 'data', 'capabilities.json'), 'utf8'))
  // snappy-gapmode-com-only / snappy-gaplevel-both-flavours / snappy-outsidepoints-both
  assert.equal(manifest.builds.com2606.snappyKeys.gapMode, true)
  assert.equal(manifest.builds.org14.snappyKeys.gapMode, false)
  assert.equal(manifest.builds.org14.snappyKeys.gapLevel, true)
  assert.equal(manifest.builds.org14.snappyKeys.outsidePoints, true)
})
