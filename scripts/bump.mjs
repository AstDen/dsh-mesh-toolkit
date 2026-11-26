#!/usr/bin/env node
// Bump the three package versions in one go.
//
//   node scripts/bump.mjs patch            # 0.5.3 → 0.5.4 and so on, all packages
//   node scripts/bump.mjs minor            # 0.5.3 → 0.6.0
//   node scripts/bump.mjs 1.0.0            # explicit version for every package
//   node scripts/bump.mjs patch --packages mesh-stl
//   node scripts/bump.mjs patch --dry-run
//
// For each selected package the script rewrites package.json, inserts a new
// "## X.Y.Z — date" section at the top of its CHANGELOG (with a TODO bullet to
// fill in) and finally rewrites the root README banner, then runs
// scripts/check-versions.mjs. Refuses to run on a dirty tree unless --force.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const ALL = ['mesh-build', 'mesh-stl', 'sim-core']

const argv = process.argv.slice(2)
const flags = new Map()
const positional = []
for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i]
  if (!arg.startsWith('--')) {
    positional.push(arg)
    continue
  }
  const [key, inline] = arg.slice(2).split('=')
  const next = argv[i + 1]
  if (inline !== undefined) flags.set(key, inline)
  else if (key === 'dry-run' || key === 'force' || key === 'no-verify') flags.set(key, true)
  else if (next !== undefined && !next.startsWith('--')) {
    flags.set(key, next)
    i += 1
  } else flags.set(key, true)
}

const requested = positional[0]
if (!requested) {
  console.error('usage: node scripts/bump.mjs patch|minor|major|X.Y.Z [--packages a,b] [--date YYYY-MM-DD] [--dry-run] [--force]')
  process.exit(2)
}

const packages = String(flags.get('packages') ?? ALL.join(','))
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)
for (const pkg of packages) {
  if (!ALL.includes(pkg)) {
    console.error(`unknown package "${pkg}"; expected one of ${ALL.join(', ')}`)
    process.exit(2)
  }
}

const date = String(flags.get('date') ?? new Date().toISOString().slice(0, 10))
const dryRun = flags.get('dry-run') === true

if (flags.get('force') !== true) {
  const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
  if (dirty) {
    console.error('working tree is dirty; commit or stash first (or pass --force):')
    console.error(dirty)
    process.exit(1)
  }
}

function bump(version, kind) {
  const [major, minor, patch] = version.split('.').map(Number)
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`
  if (kind === 'minor') return `${major}.${minor + 1}.0`
  if (kind === 'major') return `${major + 1}.0.0`
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind
  console.error(`bad version or kind: ${kind}`)
  process.exit(2)
}

const next = new Map()
for (const pkg of packages) {
  const file = join(ROOT, pkg, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  next.set(pkg, bump(manifest.version, requested))
}

for (const pkg of packages) {
  const file = join(ROOT, pkg, 'package.json')
  const manifest = JSON.parse(readFileSync(file, 'utf8'))
  const version = next.get(pkg)
  console.log(`${pkg}: ${manifest.version} → ${version}`)
  if (dryRun) continue

  manifest.version = version
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)

  const changelogFile = join(ROOT, pkg, 'CHANGELOG.md')
  const changelog = readFileSync(changelogFile, 'utf8')
  const heading = changelog.match(/^# Changelog[^\n]*\n+/)
  if (!heading) {
    console.error(`${pkg}: CHANGELOG.md does not start with "# Changelog"`)
    process.exit(1)
  }
  const section = `## ${version} — ${date}\n\n- TODO: опишите изменения\n\n`
  writeFileSync(changelogFile, changelog.replace(heading[0], `${heading[0]}${section}`))
}

if (!dryRun) {
  const readmeFile = join(ROOT, 'README.md')
  const readme = readFileSync(readmeFile, 'utf8')
  const banner = readme.match(/^> \*\*([^*]+)\*\* · packages: mesh-build (\S+) · mesh-stl (\S+) · sim-core (\S+)/m)
  if (!banner) {
    console.error('README.md: banner line not found')
    process.exit(1)
  }
  const build = next.get('mesh-build') ?? banner[2]
  const stl = next.get('mesh-stl') ?? banner[3]
  const core = next.get('sim-core') ?? banner[4]
  const replacement = `> **${build}** · packages: mesh-build ${build} · mesh-stl ${stl} · sim-core ${core}`
  writeFileSync(readmeFile, readme.replace(banner[0], replacement))
  console.log(`README banner → ${replacement}`)

  if (flags.get('no-verify') !== true) {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'check-versions.mjs')], { cwd: ROOT, stdio: 'inherit' })
  }
}
