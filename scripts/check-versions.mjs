#!/usr/bin/env node
// Version and packaging consistency for the published tree.
//
//   package.json version  ==  newest "## X.Y.Z" heading in its CHANGELOG
//   root README banner     ==  the three package.json versions
//   engines.node           ==  ">=20" everywhere
//   engines.dsh            ==  one and the same range on all three packages
//   license                ==  MIT, repository points at AstDen/dsh-mesh-toolkit
//   dsh.bundle.patch       ==  the patched file exists (plugins only)
//
// Exit 0 = consistent, exit 1 = mismatch (printed to stderr).
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGES = ['mesh-build', 'mesh-stl', 'sim-core']
const PLUGINS = new Set(['mesh-build', 'mesh-stl'])
const README_BANNER = /^> \*\*([^*]+)\*\* · packages: mesh-build (\S+) · mesh-stl (\S+) · sim-core (\S+)/m
// X.Y.Z, or a semver prerelease such as 1.0.0-rc.1
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?$/

const problems = []
const versions = new Map()

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'))
}

for (const pkg of PACKAGES) {
  const manifest = readJson(join(ROOT, pkg, 'package.json'))
  const version = manifest.version
  versions.set(pkg, version)
  if (typeof version !== 'string' || !SEMVER.test(version)) {
    problems.push(`${pkg}: package.json version ${JSON.stringify(version)} is not X.Y.Z or X.Y.Z-prerelease`)
  }

  const changelog = join(ROOT, pkg, 'CHANGELOG.md')
  if (!existsSync(changelog)) {
    problems.push(`${pkg}: CHANGELOG.md is missing`)
  } else {
    const heading = readFileSync(changelog, 'utf8').match(/^## (\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?)/m)
    if (!heading) problems.push(`${pkg}: CHANGELOG.md has no "## X.Y.Z" heading`)
    else if (heading[1] !== version) problems.push(`${pkg}: CHANGELOG says ${heading[1]}, package.json says ${version}`)
  }

  if (manifest.license !== 'MIT') problems.push(`${pkg}: license is ${JSON.stringify(manifest.license)}, expected "MIT"`)
  const repo = manifest.repository
  const url = typeof repo === 'string' ? repo : repo?.url
  if (!url || !/AstDen\/dsh-mesh-toolkit/.test(url)) problems.push(`${pkg}: repository does not point at AstDen/dsh-mesh-toolkit (${JSON.stringify(repo)})`)
  else if (!/^git\+https:|^https:/.test(url)) problems.push(`${pkg}: repository url should be git+https:// (${url})`)
  if (repo && typeof repo === 'object' && repo.directory !== pkg) problems.push(`${pkg}: repository.directory should be "${pkg}"`)

  if (manifest.engines?.node !== '>=20') problems.push(`${pkg}: engines.node is ${JSON.stringify(manifest.engines?.node)}, expected ">=20"`)
  if (typeof manifest.engines?.dsh !== 'string' || manifest.engines.dsh.trim() === '') {
    problems.push(`${pkg}: engines.dsh is not declared`)
  }

  if (PLUGINS.has(pkg)) {
    const patch = manifest.dsh?.bundle?.patch
    if (typeof patch !== 'string') problems.push(`${pkg}: dsh.bundle.patch is not declared`)
    else if (!existsSync(join(ROOT, pkg, patch))) problems.push(`${pkg}: dsh.bundle.patch points at a missing file (${patch})`)
  }
}

const dshRanges = PACKAGES.map((pkg) => readJson(join(ROOT, pkg, 'package.json')).engines?.dsh).filter(Boolean)
if (new Set(dshRanges).size > 1) problems.push(`engines.dsh differs across packages: ${dshRanges.join(' | ')}`)

const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
const banner = readme.match(README_BANNER)
if (!banner) {
  problems.push('README.md: no "> **X** · packages: mesh-build A · mesh-stl B · sim-core C" banner')
} else {
  const [, bannerVersion, build, stl, core] = banner
  if (bannerVersion !== build) problems.push(`README banner version ${bannerVersion} != mesh-build ${build}`)
  for (const [pkg, value] of [
    ['mesh-build', build],
    ['mesh-stl', stl],
    ['sim-core', core],
  ]) {
    if (value !== versions.get(pkg)) problems.push(`README banner says ${pkg} ${value}, package.json says ${versions.get(pkg)}`)
  }
}

console.log('package        version   engines.dsh')
for (const pkg of PACKAGES) {
  const manifest = readJson(join(ROOT, pkg, 'package.json'))
  console.log(`${pkg.padEnd(14)} ${String(versions.get(pkg)).padEnd(9)} ${manifest.engines?.dsh ?? '(none)'}`)
}

if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`)
  for (const problem of problems) console.error(' -', problem)
  process.exit(1)
}
console.log('versions OK')
