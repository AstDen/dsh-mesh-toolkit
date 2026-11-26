#!/usr/bin/env node
// Build (or check) the format-1 plugin-market index for this repository.
//
// A dsh plugin market is just a JSON index at an https URL that the user adds as
// an index source; this script produces `market/index.json` from the root
// `package.json`, pinning the git source to a full commit so an install is
// reproducible. The result is validated with the official parser
// (@deepseek-ai/dsh-plugin-market-index) when that package can be found.
//
//   node scripts/make-index.mjs            # write market/index.json for HEAD
//   node scripts/make-index.mjs --check    # validate the committed file instead
//
// The index URL the marketplace sees is the raw GitHub URL below; relative icon
// references resolve against it, so the file must live in `market/` in the repo.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO = resolve(fileURLToPath(new URL('..', import.meta.url)))
const INDEX_PATH = join(REPO, 'market', 'index.json')
// No redirects: dsh fetches the index with `redirect: 'error'`, and raw.githubusercontent serves 200 directly.
const INDEX_URL = 'https://raw.githubusercontent.com/AstDen/dsh-mesh-toolkit/master/market/index.json'
const CHECK = process.argv.includes('--check')

const PACKAGE = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
const DSH_RANGE = PACKAGE.engines?.dsh ?? '>=0.2.2-rc.1 <0.3.0'

// The published repository is English-only, so the index carries English text.
const TITLE = 'Mesh toolkit — pore-scale meshing for OpenFOAM'
const DESCRIPTION = 'STL generation and QA, snappyHexMesh / cfMesh / gmsh routes, a quality gate read from checkMesh, a mesh passport, delivery to OpenFOAM and Ansys Fluent, and a handoff file other plugins can consume.'
const INDEX_TITLE = 'Mesh toolkit'

function git(...args) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim()
}

function headCommit() {
  try {
    return git('rev-parse', 'HEAD')
  } catch {
    return null
  }
}

function commitSeconds(commit) {
  const stamp = Number(git('show', '-s', '--format=%ct', commit))
  return Number.isInteger(stamp) && stamp > 0 ? stamp : Math.floor(Date.now() / 1000)
}

function build(commit, seconds) {
  return {
    format: 1,
    title: INDEX_TITLE,
    description: 'Plugins for agent-driven volume meshing: STL in, gated OpenFOAM / Fluent mesh out.',
    metadata: {
      categories: {
        meshing: { title: 'Meshing' },
        geometry: { title: 'Geometry' },
      },
      labels: {
        openfoam: { title: 'OpenFOAM' },
        'pore-scale': { title: 'Pore-scale' },
        'ansys-fluent': { title: 'Ansys Fluent' },
        'quality-gate': { title: 'Quality gate' },
      },
      sortKeys: {},
    },
    plugins: [
      {
        name: PACKAGE.name,
        title: TITLE,
        description: DESCRIPTION,
        icon: 'icon.svg',
        author: 'AstDen',
        homepage: PACKAGE.homepage ?? 'https://github.com/AstDen/dsh-mesh-toolkit#readme',
        repository: { url: 'https://github.com/AstDen/dsh-mesh-toolkit' },
        metadata: {
          category: 'meshing',
          keywords: [
            'openfoam', 'snappyhexmesh', 'cfmesh', 'gmsh', 'stl', 'checkmesh',
            'pore-scale', 'porous-media', 'ansys-fluent', 'quality-gate', 'mesh-quality',
          ],
          labels: ['openfoam', 'pore-scale', 'ansys-fluent', 'quality-gate'],
          sortKeys: {},
        },
        versions: [
          {
            version: PACKAGE.version,
            publishTimestamp: seconds,
            source: { type: 'git', url: 'https://github.com/AstDen/dsh-mesh-toolkit', commit },
            engines: { dsh: DSH_RANGE },
          },
        ],
      },
    ],
  }
}

/** Locate the official validator: installed package, explicit env path, or a dsh npx checkout. */
async function loadValidator() {
  const candidates = [
    process.env.DSH_MARKET_INDEX_DIR,
    join(REPO, 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index'),
  ].filter(Boolean)
  for (const root of candidates) {
    if (existsSync(join(root, 'package.json'))) return import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  }
  const npx = join(homedir(), '.npm', '_npx')
  if (existsSync(npx)) {
    for (const entry of readdirSync(npx)) {
      const root = join(npx, entry, 'node_modules', '@deepseek-ai', 'dsh-plugin-market-index')
      if (existsSync(join(root, 'package.json'))) return import(pathToFileURL(join(root, 'lib', 'index.js')).href)
    }
  }
  return null
}

const index = CHECK
  ? JSON.parse(readFileSync(INDEX_PATH, 'utf8'))
  : build(headCommit(), commitSeconds(headCommit()))

const problems = []
if (index.plugins?.[0]?.name !== PACKAGE.name) problems.push(`plugin name ${index.plugins?.[0]?.name} != package name ${PACKAGE.name}`)
if (index.plugins?.[0]?.versions?.[0]?.version !== PACKAGE.version) {
  problems.push(`pinned version ${index.plugins?.[0]?.versions?.[0]?.version} != package.json ${PACKAGE.version}`)
}

const validator = await loadValidator()
if (validator) {
  try {
    validator.parseMarketIndex(index, INDEX_URL)
    console.log('official parser: OK')
  } catch (error) {
    problems.push(`official parser: ${error.message}`)
  }
} else {
  console.log('official parser: SKIP (install @deepseek-ai/dsh-plugin-market-index or set DSH_MARKET_INDEX_DIR)')
}

if (CHECK) {
  const commit = index.plugins?.[0]?.versions?.[0]?.source?.commit
  if (!/^[0-9a-f]{40}$/.test(commit ?? '')) {
    problems.push(`source.commit ${JSON.stringify(commit)} is not a lowercase 40-hex commit`)
  } else if (!existsSync(join(REPO, '.git'))) {
    problems.push('no .git — cannot confirm the pinned commit is in history')
  } else {
    // A shallow clone (CI defaults to fetch-depth 1) cannot see older commits, and
    // reporting that as a broken pin sends people hunting a defect that is not there.
    const shallow = existsSync(join(REPO, '.git', 'shallow'))
    try {
      execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: REPO, stdio: 'ignore' })
    } catch {
      if (shallow) {
        console.log(`pin ${commit.slice(0, 7)} is not in this shallow clone — history check skipped`)
      } else {
        problems.push(`pinned commit ${commit} is not in this repository's history — rerun without --check`)
      }
    }
  }
  if (problems.length > 0) {
    console.error(`market index check FAILED:\n  - ${problems.join('\n  - ')}`)
    process.exit(1)
  }
  console.log(`market index OK: ${index.plugins.length} plugin(s), ${PACKAGE.name}@${PACKAGE.version}`)
} else {
  mkdirSync(join(REPO, 'market'), { recursive: true })
  writeFileSync(INDEX_PATH, `${JSON.stringify(index, null, 2)}\n`)
  console.log(`wrote market/index.json: ${PACKAGE.name}@${PACKAGE.version} -> ${index.plugins[0].versions[0].source.commit}`)
  if (problems.length > 0) {
    console.error(`market index problems:\n  - ${problems.join('\n  - ')}`)
    process.exit(1)
  }
}
