import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * First-layer sizing from a y+ target (flat-plate correlations), the inverse check, and the layer count.
 *
 * The correlation matches what the workbench's `openfoam_compute_first_layer` documents (plan A5: adopt the
 * behaviour, not the code): skin friction Cf = 0.026·Re^(-1/7), u_τ = U·√(Cf/2), first layer y⁺·ν/u_τ,
 * boundary-layer thickness δ = 0.37·L·Re^(-0.2), layers cover `coverage`·δ with geometric growth.
 *
 * The result is also shaped for `mesh_build({ scaffold: true, scaffoldOptions })`: snappy needs
 * `layerSurfaces`, `nLayers`, `layerThickness` (written as finalLayerThickness), `expansionRatio`, and a
 * `minVol` small enough not to delete the layers — minVol = (firstLayer³)/6, the project rule h_min³/6.
 *
 * IMPORTANT: the scaffold writes `relativeSizes true`, so `layerThickness` is RELATIVE to the cell size at
 * the surface (after refinement). Pass `cellSize` (that local size, metres) to get relative layers; with an
 * absolute thickness snappy removes every layer (`Extruding 0 out of N faces`) because it is below minThickness.
 */

const AIR_NU = 1.5e-5 // m²/s at ~20 °C, the project's default for air

function positive(name, value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number, got ${JSON.stringify(value)}`)
  return number
}

/** Flat-plate skin friction coefficient. */
export function skinFriction(Re) {
  return 0.026 * Math.pow(Re, -1 / 7)
}

/** Friction velocity from the free-stream speed and the skin friction coefficient. */
export function frictionVelocity({ uRef, re }) {
  return uRef * Math.sqrt(skinFriction(re) / 2)
}

/**
 * Size the near-wall layers for a y+ target.
 * Returns dimensions in metres plus a ready scaffoldOptions block.
 */
export function computeFirstLayer(options = {}) {
  const uRef = positive('uRef', options.uRef)
  const lRef = positive('lRef', options.lRef)
  const nu = positive('nu', options.nu ?? AIR_NU)
  const yPlusTarget = positive('yPlusTarget', options.yPlusTarget ?? 1)
  const expansionRatio = positive('expansionRatio', options.expansionRatio ?? 1.2)
  const coverage = positive('coverage', options.coverage ?? 0.7)
  if (expansionRatio <= 1) throw new Error(`expansionRatio must be > 1, got ${expansionRatio}`)
  if (coverage > 1) throw new Error(`coverage must be in (0, 1], got ${coverage}`)
  const cellSize = options.cellSize == null ? null : positive('cellSize', options.cellSize)

  const re = (uRef * lRef) / nu
  const cf = skinFriction(re)
  const uTau = uRef * Math.sqrt(cf / 2)
  const delta = 0.37 * lRef * Math.pow(re, -0.2)
  const firstLayer = (yPlusTarget * nu) / uTau
  const targetThickness = coverage * delta
  const nLayers = Math.max(1, Math.ceil(Math.log(1 + (targetThickness * (expansionRatio - 1)) / firstLayer) / Math.log(expansionRatio)))
  const totalThickness = (firstLayer * (Math.pow(expansionRatio, nLayers) - 1)) / (expansionRatio - 1)
  const lastLayer = firstLayer * Math.pow(expansionRatio, nLayers - 1)
  const notes = []

  if (re < 5e5) {
    notes.push(`Re ${re.toFixed(0)} is below 5e5: the flat-plate turbulent correlation is outside its range — treat the numbers as a starting point and check y+ after the run`)
  }
  if (nLayers > 30) {
    notes.push(`${nLayers} layers would cover ${(totalThickness * 1e3).toFixed(2)} mm: check that the domain is thick enough, or raise the y+ target`)
  }
  if (!options.layerSurfaces) {
    notes.push('pass layerSurfaces (STL surface names) to get a scaffoldOptions block ready for mesh_build')
  }
  if (options.layerSurfaces && !cellSize) {
    notes.push('no cellSize given: snappy layerThickness is relative to the near-wall cell, so the scaffoldOptions block would be absolute and snappy would drop the layers — pass cellSize (metres, after refinement) or caseDir')
  }

  const result = {
    ok: true,
    input: { uRef, lRef, nu, yPlusTarget, expansionRatio, coverage },
    Re: re,
    Cf: cf,
    uTau,
    delta_m: delta,
    firstLayer_m: firstLayer,
    nLayers,
    expansionRatio,
    coverage,
    totalThickness_m: totalThickness,
    lastLayer_m: lastLayer,
    yPlusFirst: yPlusTarget,
    yPlusLast: (lastLayer * uTau) / nu,
    cellSize_m: cellSize,
    relativeFirstLayer: cellSize ? firstLayer / cellSize : null,
    relativeLastLayer: cellSize ? lastLayer / cellSize : null,
    notes,
  }
  if (Array.isArray(options.layerSurfaces) && options.layerSurfaces.length) {
    result.scaffoldOptions = {
      layerSurfaces: options.layerSurfaces.map(String),
      nLayers,
      // relativeSizes true in the scaffold: finalLayerThickness is relative to the local cell
      layerThickness: cellSize ? lastLayer / cellSize : lastLayer,
      expansionRatio,
      minVol: Math.pow(firstLayer, 3) / 6,
    }
    if (cellSize) {
      result.scaffoldOptions.layerThicknessRelative = true
      if (result.scaffoldOptions.layerThickness < (options.minThickness ?? 0.075)) {
        notes.push(`relative final layer ${result.scaffoldOptions.layerThickness.toFixed(4)} is below minThickness 0.075: snappy would drop the layers — refine the surface (smaller cellSize) or target a larger y+`)
      }
    } else {
      result.scaffoldOptions.layerThicknessRelative = false
    }
  }
  return result
}

/**
 * Contract §3.3 `yplus` helper: first layer for a y+ target (same correlation, thin wrapper with the
 * feedback document's field name).
 */
export function firstLayerFromYPlus({ yPlus, yPlusTarget, uRef, lRef, nu }) {
  return computeFirstLayer({ uRef, lRef, nu, yPlusTarget: yPlus ?? yPlusTarget ?? 1 })
}

/**
 * Near-wall cell size of an existing case (metres), without running anything:
 * background cell from `system/blockMeshDict` hex counts + `constant/polyMesh/points` bounding box,
 * divided by 2^max(refinement level) of `system/snappyHexMeshDict`.
 */
export function caseCellSize(caseDir) {
  const read = (rel) => {
    try { return readFileSync(join(caseDir, rel), 'utf8') } catch { return null }
  }
  const hex = read('system/blockMeshDict')
  const points = read('constant/polyMesh/points')
  if (!hex || !points) return { ok: false, error: 'blockMeshDict or polyMesh/points not found — pass cellSize explicitly' }
  const counts = /hex\s*\([^)]*\)\s*\(\s*(\d+)\s+(\d+)\s+(\d+)\s*\)/.exec(hex)
  if (!counts) return { ok: false, error: 'no hex (a b c) (nx ny nz) in system/blockMeshDict — pass cellSize explicitly' }
  const [nx, ny, nz] = counts.slice(1, 4).map(Number)
  const coords = [...points.matchAll(/\(\s*([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s*\)/g)]
  if (!coords.length) return { ok: false, error: 'could not read vertices from constant/polyMesh/points' }
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (const m of coords) {
    for (let i = 0; i < 3; i += 1) {
      const v = Number(m[i + 1])
      if (v < min[i]) min[i] = v
      if (v > max[i]) max[i] = v
    }
  }
  const coarse = Math.min((max[0] - min[0]) / nx, (max[1] - min[1]) / ny, (max[2] - min[2]) / nz)
  const snappy = read('system/snappyHexMeshDict') ?? ''
  let level = 0
  for (const m of snappy.matchAll(/level\s*\(\s*(\d+)\s+(\d+)\s*\)/g)) level = Math.max(level, Number(m[1]), Number(m[2]))
  if (!Number.isFinite(coarse) || coarse <= 0) return { ok: false, error: 'background cell size is not finite — pass cellSize explicitly' }
  return { ok: true, background_m: coarse, level, cellSize_m: coarse / Math.pow(2, level), bbox_m: { min, max }, cells: [nx, ny, nz] }
}

/**
 * Invert: what y+ does a first layer of `firstLayer` metres give at this speed/length?
 * Use it after a run, or when a vendor mesh already fixes the layer thickness.
 */
export function yPlusFromThickness(options = {}) {
  const uRef = positive('uRef', options.uRef)
  const lRef = positive('lRef', options.lRef)
  const nu = positive('nu', options.nu ?? AIR_NU)
  const firstLayer = positive('firstLayer', options.firstLayer ?? options.firstLayer_m)
  const re = (uRef * lRef) / nu
  const cf = skinFriction(re)
  const uTau = uRef * Math.sqrt(cf / 2)
  const yPlus = (firstLayer * uTau) / nu
  const delta = 0.37 * lRef * Math.pow(re, -0.2)
  const notes = []
  if (firstLayer > delta / 10) notes.push(`firstLayer ${(firstLayer * 1e3).toFixed(4)} mm is more than delta/10 (${(delta / 10 * 1e3).toFixed(4)} mm): resolving the wall is questionable`)
  if (yPlus > 300) notes.push(`y+ ${yPlus.toFixed(1)} is far above the wall-function range — a wall-function model may be the better choice`)
  return {
    ok: true,
    input: { uRef, lRef, nu, firstLayer },
    Re: re,
    Cf: cf,
    uTau,
    delta_m: delta,
    firstLayer_m: firstLayer,
    yPlus,
    notes,
  }
}

/** Simple y+ from a known wall shear stress (when a run reports tau_w). */
export function yPlusFromShear({ uTau, firstLayer, nu = AIR_NU }) {
  const tauU = positive('uTau', uTau)
  const y = positive('firstLayer', firstLayer)
  const kin = positive('nu', nu)
  return { ok: true, uTau: tauU, firstLayer_m: y, nu: kin, yPlus: (y * tauU) / kin }
}
