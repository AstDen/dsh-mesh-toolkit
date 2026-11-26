/**
 * Plan A3: turn a `mesh-feedback/1` document into the next revision of a mesh.
 *
 * The reaction table lives in `data/advice.json` (data, not code): each category lists a ladder of ops
 * with a ceiling, and `mesh_revise` applies the NEXT rung, counted from the revisions recorded in
 * `handoff.json` history. Nothing here runs a command — `planRevision()` is pure, the tool layer applies
 * the plan through mesh_build / mesh_check / mesh_patch_types.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { stem } from './common.js'
import { firstLayerFromYPlus, skinFriction } from './firstlayer.js'

export const FEEDBACK_SCHEMA = 'mesh-feedback/1'

export { firstLayerFromYPlus, skinFriction }

export function loadAdvice(dataDir) {
  const file = join(dataDir, 'advice.json')
  if (!existsSync(file)) return { error: `advice table not found: ${file}` }
  try {
    const advice = JSON.parse(readFileSync(file, 'utf8'))
    if (!advice?.categories || typeof advice.categories !== 'object') return { error: `advice table has no categories: ${file}` }
    return { advice, file }
  } catch (error) {
    return { error: `advice table is not valid JSON (${file}): ${error.message}` }
  }
}

const CATEGORY_HINT = 'categories: yplus, nonortho, skewness, patch-roles, resolution, domain, units, layers, cells-budget, stl-quality'

/** Structural validation of the incoming feedback; returns a list of human-readable problems. */
export function validateFeedback(feedback, advice) {
  const problems = []
  if (!feedback || typeof feedback !== 'object') return ['feedback must be an object (mesh-feedback/1)']
  if (feedback.schemaVersion !== FEEDBACK_SCHEMA) problems.push(`schemaVersion must be "${FEEDBACK_SCHEMA}", got "${feedback.schemaVersion ?? 'missing'}"`)
  const category = String(feedback.category ?? '')
  if (!advice?.categories?.[category]) problems.push(`unknown category "${category || 'missing'}"; ${CATEGORY_HINT}`)
  if (feedback.severity != null && !['blocker', 'major', 'minor'].includes(feedback.severity)) problems.push(`severity must be blocker|major|minor, got "${feedback.severity}"`)
  if (feedback.attempt != null && !Number.isFinite(Number(feedback.attempt))) problems.push('attempt must be a number')
  return problems
}

const revisions = (handoff) => (handoff?.history ?? []).filter((h) => h?.event === 'revision')

/** Rung index: how many revisions of this category already happened, and whether they failed. */
export function attemptState(handoff, category) {
  const all = revisions(handoff)
  const same = all.filter((h) => h.category === category)
  const trailing = all.slice().reverse()
  let consecutive = 0
  for (const entry of trailing) {
    if (entry.category !== category) break
    if (entry.verdict === 'PASS') break
    consecutive += 1
  }
  return { total: all.length, same: same.length, consecutive, lastVerdict: same.length ? same[same.length - 1].verdict ?? null : null }
}

function surfaceNames(handoff) {
  const names = (handoff?.geometry?.stls ?? []).map((s) => stem(String(s.name ?? s.file ?? ''))).filter(Boolean)
  if (names.length) return names
  const single = handoff?.geometry?.stl ? [stem(String(handoff.geometry.stl))] : []
  return single
}

/** Domain extent in metres and the implied background cell size, from the handoff. */
function sizing(handoff) {
  const min = handoff?.domain?.bbox_m?.min ?? handoff?.geometry?.bbox_m?.min
  const max = handoff?.domain?.bbox_m?.max ?? handoff?.geometry?.bbox_m?.max
  const cells = handoff?.mesh?.selection?.cells ?? null
  const extent = min && max ? [0, 1, 2].map((i) => Number(max[i]) - Number(min[i])) : null
  const cellSize = handoff?.mesh?.selection?.cellSize_m ?? (extent && cells ? Math.min(...extent.map((e, i) => e / cells[i])) : null)
  return { min: min ?? null, max: max ?? null, extent, cells, cellSize, levels: handoff?.mesh?.selection?.levels ?? {}, defaultLevel: handoff?.mesh?.selection?.defaultLevel ?? null }
}

const maxLevel = (levels) => Math.max(0, ...Object.values(levels ?? {}).map((v) => (Array.isArray(v) ? Number(v[1]) : Number(v) || 0)))

function bumpLevels(levels, step) {
  const out = {}
  const entries = Object.entries(levels ?? {})
  if (!entries.length) return out
  for (const [name, value] of entries) {
    const max = Array.isArray(value) ? Number(value[1]) : Number(value) || 0
    const min = Array.isArray(value) ? Number(value[0]) : 0
    out[name] = [min, max + step]
  }
  return out
}

/** Build the plan for one feedback document. Pure: no filesystem writes. */
export function planRevision({ feedback, handoff, advice, attempt }) {
  const problems = validateFeedback(feedback, advice)
  if (problems.length) return { ok: false, problems }

  const category = feedback.category
  const spec = advice.categories[category]
  const state = attemptState(handoff, category)
  const attemptNumber = Number(attempt ?? feedback.attempt ?? state.same + 1)
  const ceiling = Number(spec.ceiling ?? 1)
  const escalationRule = advice.escalation ?? {}
  const maxAttempts = Math.min(Number(escalationRule.maxAttemptsCap ?? 8), Math.max(1, Number(escalationRule.maxAttempts ?? 3)))

  // Route downgrade (contract §3.3, its own row with ceiling 1): after N consecutive failures of the
  // same metric, stop tuning that route and switch the assembly once. Recorded in history as a revision
  // with strategy "route-downgrade", so it cannot happen twice.
  const route = handoff?.mesh?.route ?? 'snappy'
  const downgradeRule = advice.routeDowngrade ?? {}
  const earlierDowngrades = revisions(handoff).filter((h) => h.strategy === 'route-downgrade')
  const wantsDowngrade = (downgradeRule.categories ?? []).includes(category)
    && state.consecutive >= Number(downgradeRule.afterConsecutive ?? 3)
    && (downgradeRule.from ?? []).includes(route)
    && earlierDowngrades.length < Number(downgradeRule.ceiling ?? 1)
  if (wantsDowngrade) {
    const target = downgradeRule.to ?? 'cfmesh'
    return {
      ok: true,
      category,
      attempt: attemptNumber,
      ceiling,
      strategy: 'route-downgrade',
      reason: downgradeRule.reason ?? `switch ${route} -> ${target} after ${state.consecutive} consecutive failures`,
      actions: [{ op: 'route.switch', from: route, to: target, reason: downgradeRule.reason ?? '' }],
      request: { route: target },
      requires: [join('system', 'meshDict')],
      notes: [`one downgrade per request: after it, further ${category} feedback escalates`],
      stop: null,
      problems: [],
    }
  }

  // The ladder already encodes the strategy switch (its last rung is route.switch): three failed
  // revisions of one category put the rung index past the end, so the tool stops repeating parameters
  // and changes the assembly instead. The rule itself lives in data/advice.json (routeDowngrade).
  if (attemptNumber > Math.min(ceiling, maxAttempts)) {
    return {
      ok: false,
      escalated: true,
      category,
      attempt: attemptNumber,
      ceiling,
      problems: [`attempt ${attemptNumber} is above the ceiling ${Math.min(ceiling, maxAttempts)} for "${category}"`],
      options: escalationOptions(category, handoff),
    }
  }

  const ladder = spec.ladder ?? []
  const rungIndex = Math.min(state.same, ladder.length - 1)
  const rung = ladder[rungIndex] ?? null
  if (!rung) return { ok: false, problems: [`advice table has no ladder for "${category}"`] }

  const plan = applyOp({ rung, feedback, handoff, sizing: sizing(handoff), surfaces: surfaceNames(handoff), attempt: attemptNumber })
  return {
    ok: plan.problems.length === 0,
    category,
    attempt: attemptNumber,
    ceiling,
    strategy: 'ladder',
    rung: rungIndex,
    rungCount: ladder.length,
    reason: rung.reason ?? spec.blurb ?? '',
    actions: plan.actions,
    request: plan.request,
    requires: plan.requires ?? [],
    notes: plan.notes ?? [],
    stop: plan.stop ?? null,
    problems: plan.problems,
  }
}

function escalationOptions(category, handoff) {
  const cells = handoff?.mesh?.cells ?? null
  const common = [
    { id: 'accept-current', label: 'Keep the current mesh and let the solver run', cost: '0 extra cells', effect: 'the metric stays as reported' },
    { id: 'relaxed-gate', label: 'Re-check with the relaxed gate profile (75° / skew 4)', cost: '0 extra cells', effect: 'turns solver-risky cells into a warning, not a fix' },
  ]
  if (category === 'nonortho' || category === 'skewness') {
    return [
      { id: 'refine-further', label: 'One more refinement level on the surface', cost: `~${cells ? Math.round(cells * 2.5) : '2.5x'} cells`, effect: 'lower non-orthogonality, longer run' },
      { id: 'cfmesh', label: 'Rebuild with cfMesh (Voronoi cartesian)', cost: '~3.7x cells at the same size', effect: 'stable ~61°, may still fail the project gate' },
      ...common,
    ]
  }
  if (category === 'yplus') {
    return [
      { id: 'more-layers', label: 'More layers at the same first-layer thickness', cost: `~${cells ? Math.round(cells * 1.2) : '1.2x'} cells`, effect: 'smoother wall gradient, needs minTwist room' },
      { id: 'coarser-target', label: 'Accept a coarser y+ target (wall functions)', cost: '0 extra cells', effect: 'y+ ~30-100, wall-function territory' },
      ...common,
    ]
  }
  return common
}

function applyOp({ rung, feedback, handoff, sizing, surfaces, attempt }) {
  const actions = []
  const request = { scaffoldOptions: {} }
  const problems = []
  const notes = []
  const changes = feedback.changes ?? {}
  const metrics = feedback.evidence?.metrics ?? {}

  const need = (keys, from) => {
    const missing = keys.filter((k) => from[k] == null || from[k] === '' || !Number.isFinite(Number(from[k])))
    if (missing.length) problems.push(`${rung.op} needs ${missing.join(', ')} in feedback.changes (or feedback.evidence.metrics); got ${JSON.stringify(from)}`)
    return missing.length === 0
  }

  switch (rung.op) {
    case 'layers.yplus': {
      const source = {
        uRef: changes.uRef ?? metrics.uRef ?? feedback.evidence?.uRef,
        lRef: changes.lRef ?? metrics.lRef ?? feedback.evidence?.lRef,
        nu: changes.nu ?? metrics.nu ?? feedback.evidence?.nu ?? 1.5e-5,
      }
      const target = Number(changes.yPlusTarget ?? feedback.expected?.yPlusMax ?? rung.defaults?.yPlusTarget ?? 1)
      const nLayers = Math.max(1, Math.round(Number(changes.nLayers ?? rung.defaults?.nLayers ?? 5)))
      if (!need(['uRef', 'lRef'], source)) {
        problems.push('yplus: uTau needs uRef (m/s) and lRef (m); nu defaults to 1.5e-5 m^2/s. Pass feedback.changes.uRef/lRef or evidence.metrics.uRef/lRef')
        break
      }
      const computed = firstLayerFromYPlus({ yPlus: target, uRef: source.uRef, lRef: source.lRef, nu: source.nu })
      const localH = sizing.cellSize ? sizing.cellSize / Math.pow(2, maxLevel(sizing.levels)) : null
      const expansion = Number(changes.expansionRatio ?? rung.defaults?.expansionRatio ?? 1.2)
      // snappy's relativeSizes takes the FINAL layer thickness; derive it from the target first layer, and
      // pick a layer count that reaches roughly half a cell at the wall (otherwise snappy extrudes nothing).
      const firstRel = localH ? computed.firstLayer_m / localH : null
      let layersWanted = nLayers
      if (firstRel && changes.nLayers == null) {
        const finalTargetRel = 0.5
        layersWanted = Math.round(Math.log(finalTargetRel / firstRel) / Math.log(expansion))
        layersWanted = Math.min(10, Math.max(2, layersWanted))
      }
      const finalRel = firstRel ? Math.min(1.5, firstRel * Math.pow(expansion, layersWanted - 1)) : 0.5
      request.scaffoldOptions.layerSurfaces = surfaces
      request.scaffoldOptions.nLayers = layersWanted
      request.scaffoldOptions.layerThickness = Number(finalRel.toFixed(4))
      request.scaffoldOptions.expansionRatio = expansion
      // snappy judges its own mesh against minVol; layers are thin, so the extrusion threshold must be
      // the first-layer scale (h_min^3/6), not the gate threshold — otherwise snappy removes every layer
      // (DEF-10 in benchmark/runs/20261125-1805). The gate still runs at the unchanged minVol afterwards.
      const snappyMinVol = Math.pow(computed.firstLayer_m, 3) / 6
      request.scaffoldOptions.minVol = Math.min(Number(handoff?.quality?.minVol ?? 1e-12), snappyMinVol)
      // A layered mesh has cells as thin as the first layer: h_min^3/6 is also the honest gate threshold.
      request.gateMinVol = request.scaffoldOptions.minVol
      actions.push({
        op: rung.op,
        action: `layers on ${surfaces.join(', ') || '(no surface)'}: nLayers ${layersWanted}, first layer ${(computed.firstLayer_m * 1e6).toFixed(2)} um (relative ${firstRel == null ? 'n/a' : firstRel.toFixed(4)}), final relative ${finalRel.toFixed(3)}, expansion ${expansion}`,
        yPlusTarget: target,
        uTau: Number(computed.uTau.toFixed(5)),
        firstLayer_m: Number(computed.firstLayer_m.toExponential(4)),
        Re: Number(computed.Re.toFixed(1)),
      })
      if (!localH) notes.push('cellSize_m is unknown in the handoff: the layer thickness falls back to the relative default 0.5')
      break
    }
    case 'refine.level': {
      const step = Number(rung.step ?? 1)
      request.scaffoldOptions.refinementLevels = bumpLevels(sizing.levels, step)
      actions.push({ op: rung.op, action: `refinement levels +${step}: ${JSON.stringify(request.scaffoldOptions.refinementLevels)}` })
      break
    }
    case 'layers.reduceLayers': {
      const current = Number(handoff?.mesh?.layers?.nLayers ?? 3)
      const next = Math.max(1, current - Number(rung.step ?? 1))
      request.scaffoldOptions.layerSurfaces = surfaces
      request.scaffoldOptions.nLayers = next
      actions.push({ op: rung.op, action: `nLayers ${current} -> ${next} on ${surfaces.join(', ') || '(no surface)'}` })
      break
    }
    case 'route.switch': {
      request.route = rung.to ?? 'cfmesh'
      actions.push({ op: rung.op, action: `route ${handoff?.mesh?.route ?? 'snappy'} -> ${request.route}` })
      if (String(request.route) === 'cfmesh') {
        const meshDict = join('system', 'meshDict')
        const exists = handoff?.caseDir ? existsSync(join(handoff.caseDir, meshDict)) : false
        if (!exists) notes.push('cfMesh needs system/meshDict (surfaceFile + cell sizes, units in metres): write it before the rebuild — see hint cfmesh-cartesian')
      }
      break
    }
    case 'skewness.refine': {
      request.scaffoldOptions.refinementLevels = bumpLevels(sizing.levels, Number(rung.levelStep ?? 1))
      request.scaffoldOptions.resolveFeatureAngle = Number(rung.resolveFeatureAngle ?? 20)
      actions.push({ op: rung.op, action: `refinement levels +${rung.levelStep ?? 1}, resolveFeatureAngle ${rung.resolveFeatureAngle ?? 20}` })
      break
    }
    case 'patches.retype': {
      const roles = changes.roles ?? (handoff?.next ?? []).find((n) => n?.tool === 'mesh_patch_types')?.args?.roles ?? null
      if (!roles) {
        problems.push('patches.retype needs feedback.changes.roles, e.g. {"inlet":["world"],"outlet":["a1-cube"]}')
        break
      }
      request.patchRoles = roles
      actions.push({ op: rung.op, action: `retype by roles ${JSON.stringify(roles)}` })
      break
    }
    case 'sizing.scale': {
      const factor = Number(changes.cellSizeFactor ?? rung.cellSizeFactor ?? 0.7)
      const cells = sizing.cells
      if (!cells) {
        problems.push('sizing.scale needs mesh.selection.cells in handoff.json')
        break
      }
      const next = cells.map((n) => Math.max(4, Math.round(Number(n) / factor)))
      const maxCells = Number(changes.maxCells ?? rung.maxCells ?? 5_000_000)
      const predicted = next[0] * next[1] * next[2]
      request.scaffoldOptions.cells = next
      actions.push({ op: rung.op, action: `background ${cells.join('x')} -> ${next.join('x')} (cellSize x${factor}), predicted ${predicted} cells`, predictedCells: predicted })
      if (predicted > maxCells) notes.push(`predicted background ${predicted} exceeds maxCells ${maxCells}: the build will warn and may be stopped`)
      break
    }
    case 'domain.grow': {
      const factor = Number(changes.domainFactor ?? rung.factor ?? 1.25)
      const direction = String(changes.direction ?? 'all').toLowerCase()
      const { min, max, extent } = sizing
      if (!min || !max || !extent) {
        problems.push('domain.grow needs domain.bbox_m (or geometry.bbox_m) in handoff.json')
        break
      }
      const axes = direction === 'all' ? [0, 1, 2] : ['x', 'y', 'z'].indexOf(direction)
      const axisList = direction === 'all' ? [0, 1, 2] : (axes >= 0 ? [axes] : null)
      if (!axisList) {
        problems.push(`domain.grow direction must be x, y, z or all; got "${direction}"`)
        break
      }
      const add = [0, 0, 0]
      for (const i of axisList) add[i] = ((extent[i] * (factor - 1)) / 2)
      const domainMin = min.map((v, i) => Number((v - add[i]).toFixed(9)))
      const domainMax = max.map((v, i) => Number((v + add[i]).toFixed(9)))
      request.scaffoldOptions.domainMin = domainMin
      request.scaffoldOptions.domainMax = domainMax
      actions.push({ op: rung.op, action: `domain x${factor} on ${direction}: ${domainMin.join(',')} .. ${domainMax.join(',')}` })
      break
    }
    case 'units.confirm': {
      const scale = Number(changes.scale)
      if (!Number.isFinite(scale) || scale <= 0) {
        problems.push('units.confirm needs feedback.changes.scale (e.g. 0.001 for an STL in mm); a silent rebuild is not allowed')
        break
      }
      if (Math.abs(scale - 0.001) > 1e-12) {
        problems.push(`units.confirm: the scaffold writes scale 0.001 (STL in mm); scale ${scale} needs the STL converted to metres first`)
        break
      }
      request.scaffoldOptions.scaleConfirmed = true
      actions.push({ op: rung.op, action: `scale ${scale} confirmed` })
      break
    }
    case 'layers.reduceRatio': {
      const current = Number(handoff?.mesh?.layers?.expansionRatio ?? 1.5)
      const next = Math.max(1.05, Number((current * Number(rung.ratioFactor ?? 0.8)).toFixed(3)))
      request.scaffoldOptions.layerSurfaces = surfaces
      request.scaffoldOptions.nLayers = Number(handoff?.mesh?.layers?.nLayers ?? 3)
      request.scaffoldOptions.expansionRatio = next
      request.scaffoldOptions.minTwist = Number(rung.minTwist ?? 0.02)
      actions.push({ op: rung.op, action: `expansionRatio ${current} -> ${next}, minTwist ${request.scaffoldOptions.minTwist}` })
      break
    }
    case 'sizing.coarsen': {
      const cells = sizing.cells
      const currentCells = Number(handoff?.mesh?.cells ?? 0)
      if (!cells || !currentCells) {
        problems.push('sizing.coarsen needs mesh.selection.cells and mesh.cells in handoff.json')
        break
      }
      const maxCells = Number(changes.maxCells ?? rung.maxCells ?? 3_000_000)
      const factor = Math.cbrt(maxCells / currentCells)
      const next = cells.map((n) => Math.max(4, Math.floor(Number(n) * Math.min(1, factor))))
      request.scaffoldOptions.cells = next
      actions.push({ op: rung.op, action: `coarsen ${cells.join('x')} -> ${next.join('x')} to fit ${maxCells} cells (factor ${factor.toFixed(3)})` })
      break
    }
    case 'geometry.inspect': {
      return {
        actions: [{ op: rung.op, action: 'STL inspection: run stl_check (cleanup:true) on the geometry, then rebuild from the cleaned file' }],
        request: {},
        stop: 'stl-quality',
        problems: [],
        notes: ['geometry problems are not fixable by meshing parameters: clean the STL first, then call mesh_revise again'],
      }
    }
    default:
      problems.push(`unsupported advice op "${rung.op}"`)
  }

  if (problems.length) return { actions, request: {}, problems, notes }
  request.attemptOverrides = { minVol: handoff?.quality?.minVol ?? null }
  return { actions, request, problems, notes }
}
