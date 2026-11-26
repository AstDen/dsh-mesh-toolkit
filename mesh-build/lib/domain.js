/**
 * Domain sizing and unit-suspicion helpers (workbench contract, plan A6).
 *
 * Pure functions: the caller passes an STL bounding box in millimetres and gets a domain in metres,
 * or a background cell count from a target. Nothing here touches a case directory.
 */

import { readStlBboxMm } from './precheck.js'

export const DOMAIN_TYPES = ['external', 'internal', 'wrap', 'box']

/** Multiples of L = max STL extent, one set per side (the OpenFOAM-workbench convention). */
export const DEFAULT_MARGINS = {
  upstream: 3,
  downstream: 5,
  lateral: 3,
  vertical_top: 3,
  vertical_bottom: 3,
  wrap: 0.1,
}

/** Suspicion threshold: an STL whose largest extent exceeds this (in mm) may be in metres. */
export const DEFAULT_SCALE_ASK_ABOVE_MM = 100

const AXES = ['x', 'y', 'z']

function vec(value, name) {
  const out = (value ?? []).map(Number)
  if (out.length !== 3 || !out.every(Number.isFinite)) throw new Error(`${name} must be three finite numbers`)
  return out
}

/**
 * Domain box implied by a domain mode and the STL bbox.
 * @param {{bboxMm: {min: number[], max: number[]}, type?: string, margins?: object, sizeFactor?: number, flowAxis?: string}} input
 * @returns {{domainMin: number[], domainMax: number[], type: string, margins: object, extentM: number[], notes: string[]}}
 */
export function computeDomain(input) {
  const bbox = input?.bboxMm
  if (!bbox || !Array.isArray(bbox.min) || !Array.isArray(bbox.max)) {
    throw new Error('computeDomain needs bboxMm { min: [x,y,z], max: [x,y,z] } in millimetres')
  }
  const minMm = vec(bbox.min, 'bboxMm.min')
  const maxMm = vec(bbox.max, 'bboxMm.max')
  const type = String(input.type ?? 'external').toLowerCase()
  if (!DOMAIN_TYPES.includes(type)) {
    throw new Error(`domain.type must be one of ${DOMAIN_TYPES.join(', ')}; got "${input.type}"`)
  }
  if (type === 'box') throw new Error('domain.type "box" needs explicit domainMin/domainMax — they are authoritative')
  const flowAxis = String(input.flowAxis ?? 'x').toLowerCase()
  if (!AXES.includes(flowAxis)) throw new Error(`flowAxis must be x, y or z; got "${input.flowAxis}"`)

  const notes = []
  const min = minMm.map((v) => v * 1e-3)
  const max = maxMm.map((v) => v * 1e-3)
  const extent = max.map((v, i) => v - min[i])
  const L = Math.max(...extent)
  if (!(L > 0)) throw new Error('the STL bounding box is degenerate (zero extent)')

  const requested = input.margins && typeof input.margins === 'object' ? input.margins : {}
  const margins = { ...DEFAULT_MARGINS, ...requested }
  const factor = Number(input.sizeFactor ?? 1)
  if (!Number.isFinite(factor) || factor <= 0) throw new Error('domain.sizeFactor must be a positive number')

  if (type === 'internal') {
    notes.push('domain.type "internal": the domain is the STL bounding box, no margins')
  } else if (type === 'wrap') {
    const pad = Number(margins.wrap) * L * factor
    for (let i = 0; i < 3; i += 1) {
      min[i] -= pad
      max[i] += pad
    }
    notes.push(`domain.type "wrap": ${Number(margins.wrap)}·L = ${(pad * 1e3).toFixed(3)} mm on every side`)
  } else {
    const axial = AXES.indexOf(flowAxis)
    const lateralAxes = [0, 1, 2].filter((i) => i !== axial && i !== 2)
    const up = 2
    const upstream = Number(margins.upstream) * L * factor
    const downstream = Number(margins.downstream) * L * factor
    const lateral = Number(margins.lateral) * L * factor
    const top = Number(margins.vertical_top) * L * factor
    const bottom = Number(margins.vertical_bottom) * L * factor
    min[axial] -= upstream
    max[axial] += downstream
    for (const i of lateralAxes) {
      min[i] -= lateral
      max[i] += lateral
    }
    if (!lateralAxes.includes(up)) {
      min[up] -= bottom
      max[up] += top
    }
    notes.push(
      `domain.type "external" around L = ${(L * 1e3).toFixed(3)} mm (flow axis ${flowAxis}): ` +
        `upstream ${(upstream * 1e3).toFixed(3)} mm, downstream ${(downstream * 1e3).toFixed(3)} mm, ` +
        `lateral ±${(lateral * 1e3).toFixed(3)} mm, vertical -${(bottom * 1e3).toFixed(3)}/+${(top * 1e3).toFixed(3)} mm`,
    )
  }

  const domainMin = min.map((v) => Number(v.toFixed(12)))
  const domainMax = max.map((v) => Number(v.toFixed(12)))
  const extentM = domainMax.map((v, i) => v - domainMin[i])
  return { domainMin, domainMax, type, margins, extentM, notes }
}

/** Uniform cell size that puts about `targetCells` cells into the domain volume. */
export function cellSizeFromTarget(domainMin, domainMax, targetCells) {
  const lo = vec(domainMin, 'domainMin')
  const hi = vec(domainMax, 'domainMax')
  const target = Number(targetCells)
  if (!Number.isFinite(target) || target < 1) throw new Error('targetCells must be a positive number')
  const volume = (hi[0] - lo[0]) * (hi[1] - lo[1]) * (hi[2] - lo[2])
  if (!(volume > 0)) throw new Error('domainMin must be strictly below domainMax on every axis')
  return Math.cbrt(volume / target)
}

/** Per-axis cell counts from a uniform cell size (ceil, at least 1). */
export function cellsFromSize(domainMin, domainMax, cellSize) {
  const lo = vec(domainMin, 'domainMin')
  const hi = vec(domainMax, 'domainMax')
  const size = Number(cellSize)
  if (!Number.isFinite(size) || size <= 0) throw new Error('cellSize must be a positive number of metres')
  return lo.map((v, i) => Math.max(1, Math.ceil((hi[i] - v) / size)))
}

/**
 * Does an STL bbox look like it was exported in metres while its contents are millimetre numbers?
 * We cannot know, so we ask instead of trimming silently.
 */
export function scaleSuspicion(bboxMm, options = {}) {
  const askAboveMm = Number(options.askAboveMm ?? DEFAULT_SCALE_ASK_ABOVE_MM)
  const minMm = (bboxMm?.min ?? []).map(Number)
  const maxMm = (bboxMm?.max ?? []).map(Number)
  if (minMm.length !== 3 || maxMm.length !== 3) throw new Error('scaleSuspicion needs bboxMm { min, max } in millimetres')
  const extentMm = maxMm.map((v, i) => v - minMm[i])
  const maxExtentMm = Math.max(...extentMm)
  const suspicious = maxExtentMm > askAboveMm
  return {
    suspicious,
    maxExtentMm,
    extentMm,
    askAboveMm,
    message: suspicious
      ? `the STL bbox is ${maxExtentMm.toFixed(3)} mm across, above the ${askAboveMm} mm suspicion threshold: ` +
        'if this file is really in metres, every domain margin and cell size below is 1000× too large. ' +
        'Pass scaffoldOptions.assumeUnits (mm or m) or explicit domainMin/domainMax to continue.'
      : `the STL bbox is ${maxExtentMm.toFixed(3)} mm across, within the ${askAboveMm} mm suspicion threshold`,
  }
}

/** Read the bbox of the first STL in metres of a list (mm files), for domain sizing. */
export function stlBboxMm(file) {
  const bbox = readStlBboxMm(file)
  if (!bbox) throw new Error(`could not read the STL bounding box: ${file}`)
  return bbox
}
