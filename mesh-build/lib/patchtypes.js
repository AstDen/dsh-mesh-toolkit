/**
 * Patch roles → OpenFOAM boundary types.
 *
 * After meshing a snappy case the boundary usually has one `wall` patch (all obstacle faces plus the
 * domain box) or a `symmetry`/`wall` pair, while a solver needs `inlet`/`outlet`/`walls`. Retyping is a
 * documented post-step (project AGENTS.md §13, exp-006: in a regional case `changeDictionary` does not
 * work, editing `constant/<region>/polyMesh/boundary` does). This module does exactly that edit, with a
 * `.bak` backup, a diff, and refusals instead of guesses.
 *
 * It never splits faces: retyping changes the type of an existing patch. Splitting one patch into
 * inlet/outlet needs a face set (topoSet + createPatch); the refusal says so.
 */

import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Contract roles → OpenFOAM patch types. `unknown` has no type and is never written. */
export const ROLE_TYPE = {
  inlet: 'patch',
  outlet: 'patch',
  wall: 'wall',
  symmetry: 'symmetry',
  empty: 'empty',
  interface: 'patch',
  cyclic: 'cyclic',
  wedge: 'wedge',
}

/** Roles this tool can apply safely without extra OpenFOAM setup. */
export const APPLICABLE_ROLES = ['inlet', 'outlet', 'wall', 'symmetry', 'empty', 'interface']

/** Types that cannot become a flow boundary without rebuilding the mesh. */
const STICKY_TYPES = new Set(['empty', 'cyclic', 'cyclicAMI'])

/** Plural/spelling aliases so the contract's `roles` object can be passed verbatim. */
const ROLE_ALIASES = {
  walls: 'wall',
  inlets: 'inlet',
  outlets: 'outlet',
  symmetries: 'symmetry',
  interfaces: 'interface',
  empties: 'empty',
  patches: 'interface',
}

/** Regions of a case: '' for the base mesh, `<name>` for `constant/<name>/polyMesh`. */
export function listCaseRegions(caseDir) {
  const base = join(caseDir, 'constant', 'polyMesh', 'boundary')
  const regions = existsSync(base) ? [''] : []
  const constant = join(caseDir, 'constant')
  if (existsSync(constant)) {
    for (const name of readdirSync(constant).sort()) {
      if (existsSync(join(constant, name, 'polyMesh', 'boundary'))) regions.push(name)
    }
  }
  return regions
}

/** Absolute boundary file of a region ('' = base mesh). */
export function boundaryFile(caseDir, region = '') {
  return region ? join(caseDir, 'constant', region, 'polyMesh', 'boundary') : join(caseDir, 'constant', 'polyMesh', 'boundary')
}

/**
 * Parse a boundary file into patches with the byte span of each patch body, so a retype is a surgical
 * edit of `type …;` and leaves every other attribute (nFaces, startFace, inGroups, physicalType) intact.
 */
export function parseBoundary(text) {
  const patches = []
  const head = /^\s*(\d+)\s*\(\s*$/m.exec(text)
  const start = head ? head.index + head[0].length : 0
  const re = /^(\s*)([A-Za-z_][\w.-]*)\s*\n\s*\{/gm
  re.lastIndex = start
  let m
  while ((m = re.exec(text)) !== null) {
    const open = text.indexOf('{', m.index)
    let depth = 0
    let end = -1
    for (let i = open; i < text.length; i += 1) {
      if (text[i] === '{') depth += 1
      else if (text[i] === '}') {
        depth -= 1
        if (depth === 0) { end = i; break }
      }
    }
    if (end < 0) break
    const body = text.slice(open + 1, end)
    if (!/^\s*type\s+\w+\s*;/m.test(body)) { // not a patch block (e.g. FoamFile is before `start`)
      re.lastIndex = end
      continue
    }
    const type = /^\s*type\s+(\w+)\s*;/m.exec(body)[1]
    const nFaces = Number((/^\s*nFaces\s+(\d+)\s*;/m.exec(body) ?? [])[1] ?? NaN)
    const startFace = Number((/^\s*startFace\s+(\d+)\s*;/m.exec(body) ?? [])[1] ?? NaN)
    patches.push({
      name: m[2],
      type,
      nFaces: Number.isFinite(nFaces) ? nFaces : null,
      startFace: Number.isFinite(startFace) ? startFace : null,
      bodyStart: open + 1,
      bodyEnd: end,
    })
    re.lastIndex = end
  }
  return patches
}

/** Read one region: file, text and parsed patches. */
export function readBoundary(caseDir, region = '') {
  const file = boundaryFile(caseDir, region)
  if (!existsSync(file)) return { file, region, text: null, patches: [], error: `no boundary file for region "${region || 'base'}": ${file}` }
  const text = readFileSync(file, 'utf8')
  return { file, region, text, patches: parseBoundary(text) }
}

function normalizeRoles(roles) {
  const out = []
  const problems = []
  for (const [key, value] of Object.entries(roles ?? {})) {
    const role = ROLE_ALIASES[key] ?? key
    const names = Array.isArray(value) ? value.map(String) : (value == null ? [] : [String(value)])
    if (!names.length) continue
    if (!(role in ROLE_TYPE)) {
      problems.push({ code: 'unknown-role', role, message: `unknown role "${key}"; use ${Object.keys(ROLE_TYPE).join(', ')}` })
      continue
    }
    if (role === 'cyclic' || role === 'wedge') {
      problems.push({
        code: 'needs-manual-setup',
        role,
        message: `role "${role}" cannot be applied by retyping alone: it needs a neighbourPatch (cyclic) or a wedge mesh; edit the boundary manually and rerun mesh_check`,
      })
      continue
    }
    for (const name of names) out.push({ name, role })
  }
  return { out, problems }
}

/**
 * Plan the retype without touching the case: what changes, what stays, what is refused.
 * `problems[]` are refusals (nothing is written when non-empty), `notes[]` are informational.
 */
export function planRetype({ caseDir, region, roles }) {
  const regions = listCaseRegions(caseDir)
  if (!regions.length) return { ok: false, problems: [{ code: 'no-mesh', message: `no constant/polyMesh/boundary in ${caseDir}` }] }
  if (!region && regions.length > 1) {
    return {
      ok: false,
      regions,
      problems: [{
        code: 'ambiguous-region',
        message: `the case has ${regions.length} regions (${regions.map((r) => r || 'base').join(', ')}): pass region`,
      }],
    }
  }
  const target = region ?? (regions.includes('') ? '' : regions[0])
  const loaded = readBoundary(caseDir, target)
  if (loaded.error) return { ok: false, regions, problems: [{ code: 'no-mesh', message: loaded.error }] }

  const { out, problems } = normalizeRoles(roles)
  const byName = new Map(loaded.patches.map((p) => [p.name, p]))
  const seen = new Map()
  const changes = []
  const notes = []
  for (const { name, role } of out) {
    const patch = byName.get(name)
    if (!patch) {
      problems.push({
        code: 'patch-not-found',
        name,
        role,
        message: `patch "${name}" is not in region "${target || 'base'}"; available: ${loaded.patches.map((p) => `${p.name} (${p.type})`).join(', ')}`,
        hint: 'retyping changes an existing patch; splitting a patch into inlet/outlet needs a face set (topoSet + createPatch) — see hint snappy-symmetry-domain',
      })
      continue
    }
    if (seen.has(name)) {
      problems.push({ code: 'role-conflict', name, message: `patch "${name}" is listed in more than one role (${seen.get(name)} and ${role})` })
      continue
    }
    seen.set(name, role)
    const wanted = ROLE_TYPE[role]
    if (!APPLICABLE_ROLES.includes(role)) {
      problems.push({ code: 'role-not-applicable', name, role, message: `role "${role}" is not applied by this tool` })
      continue
    }
    if (STICKY_TYPES.has(patch.type) && role !== 'empty' && role !== 'cyclic') {
      problems.push({
        code: 'incompatible-type',
        name,
        role,
        message: `patch "${name}" has type ${patch.type}: it cannot become "${role}" without rebuilding the mesh (${patch.type} is a topological constraint)`,
      })
      continue
    }
    if (patch.type === wanted) {
      notes.push(`patch "${name}" is already ${wanted} (role ${role})`)
      continue
    }
    changes.push({ name, role, from: patch.type, to: wanted, nFaces: patch.nFaces })
  }
  return {
    ok: problems.length === 0,
    caseDir,
    region: target,
    file: loaded.file,
    regions,
    patches: loaded.patches.map(({ bodyStart, bodyEnd, ...p }) => p),
    changes,
    notes,
    problems,
  }
}

/** Apply a plan: rewrite `type` in place, keep a `.bak`, return the diff and the fresh patches. */
export function applyRetype(plan) {
  if (!plan.ok) throw new Error('planRetype found problems: nothing to apply')
  if (!plan.changes.length) {
    return { file: plan.file, region: plan.region, backup: null, changes: [], before: {}, after: {}, patches: readBoundary(plan.caseDir, plan.region).patches }
  }
  const text = readFileSync(plan.file, 'utf8')
  const patches = parseBoundary(text)
  const backup = `${plan.file}.bak`
  copyFileSync(plan.file, backup)

  // Replace from the end so earlier spans stay valid.
  const edits = []
  for (const change of plan.changes) {
    const patch = patches.find((p) => p.name === change.name)
    if (!patch) throw new Error(`patch "${change.name}" disappeared between plan and apply`)
    const body = text.slice(patch.bodyStart, patch.bodyEnd)
    const replaced = body.replace(/^(\s*type\s+)\w+(\s*;)/m, `$1${change.to}$2`)
    if (replaced === body) throw new Error(`could not rewrite type of patch "${change.name}"`)
    edits.push({ start: patch.bodyStart, end: patch.bodyEnd, text: replaced })
  }
  edits.sort((a, b) => b.start - a.start)
  let out = text
  for (const edit of edits) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end)
  writeFileSync(plan.file, out)

  const fresh = readBoundary(plan.caseDir, plan.region).patches
  const before = {}
  const after = {}
  for (const change of plan.changes) {
    before[change.name] = change.from
    after[change.name] = fresh.find((p) => p.name === change.name)?.type ?? change.to
  }
  return { file: plan.file, region: plan.region, backup, changes: plan.changes, before, after, patches: fresh }
}

/**
 * Write the semantic role assignment into a `mesh-handoff/1` document that was already built.
 *
 * Inlet and outlet are both type `patch`, so the boundary file cannot carry the difference; the role lives
 * in the handoff. Doing it here (rather than only inside sim-core's builder) keeps the live process
 * consistent: sim-core modules are not evicted by a plugin toggle, mesh-build modules are.
 */
export function applyRoleAssignments(doc, assigned = {}) {
  if (!doc || !Array.isArray(doc.patches)) return doc
  const roles = { inlet: [], outlet: [], wall: [], symmetry: [], cyclic: [], empty: [], interface: [], wedge: [], unknown: [] }
  for (const patch of doc.patches) {
    const ambiguous = !patch.type || patch.type === 'patch'
    const assignedRole = ambiguous && assigned?.[patch.name] && assigned[patch.name] in roles ? assigned[patch.name] : null
    const role = assignedRole ?? (patch.role in roles ? patch.role : 'unknown')
    patch.role = role
    roles[role].push(patch.name)
  }
  doc.roles = roles
  doc.flowReady = roles.inlet.length > 0 && roles.outlet.length > 0
  const next = Array.isArray(doc.next) ? doc.next : []
  if (doc.flowReady) {
    doc.next = next.filter((n) => n?.tool !== 'mesh_patch_types')
  } else if (!next.some((n) => n?.tool === 'mesh_patch_types')) {
    const walls = roles.wall.length ? roles.wall : doc.patches.map((p) => p.name)
    doc.next = [...next, { tool: 'mesh_patch_types', args: { caseDir: '.', roles: { inlet: roles.inlet, outlet: roles.outlet, walls } } }]
  } else {
    doc.next = next
  }
  return doc
}
