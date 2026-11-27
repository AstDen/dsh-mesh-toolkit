import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * First-layer sizing from a y+ target (flat-plate correlations), the inverse check, and the layer count.
 *
 * The correlation: skin friction Cf = 0.026·Re^(-1/7) for a turbulent boundary layer and the laminar
 * Blasius value Cf = 0.664·Re^(-1/2) below Re = 5e5 (D-5: the old code used the turbulent branch for every
 * Reynolds number and only mentioned Re < 5e5 in a note). u_τ = U·√(Cf/2); the wall distance that carries
 * the target y⁺ is y⁺·ν/u_τ, and the FIRST CELL is twice that height because y⁺ is defined at the cell
 * centroid (D-5: the ×2 was missing, so every layer was half as thick as requested). δ = 0.37·L·Re^(-0.2);
 * layers cover `coverage`·δ with geometric growth.
 *
 * Pass `legacyYPlus: true` to reproduce the pre-1.3 numbers (turbulent Cf everywhere, cell height = wall
 * distance, no clamp) when comparing against older reports.
 *
 * The result is also shaped for `mesh_build({ scaffold: true, scaffoldOptions })`: snappy needs
 * `layerSurfaces`, `nLayers`, `layerThickness` (written as finalLayerThickness), `expansionRatio`, and a
 * `minVol` small enough not to delete the layers — minVol = (firstLayer³)/6, the project rule h_min³/6.
 *
 * IMPORTANT: the scaffold writes `relativeSizes true`, so `layerThickness` is RELATIVE to the cell size at
 * the surface (after refinement). Pass `cellSize` (that local size, metres) to get relative layers; with an
 * absolute thickness snappy removes every layer (`Extruding 0 out of N faces`) because it is below minThickness.
 * A first cell taller than half the near-wall cell cannot be extruded either, so the thickness is clamped to
 * 0.5·cellSize with a note (D-5).
 */

const AIR_NU = 1.5e-5 // m²/s at ~20 °C, the project's default for air
/** Transition Reynolds number for the flat-plate correlations. */
export const RE_TRANSITION = 5e5
/** First cell height / distance from the wall to its centroid: y⁺ is a centroid quantity. */
export const CELL_THICKNESS_FACTOR = 2
/** Upper bound on the first cell relative to the near-wall cell: snappy cannot extrude more. */
export const MAX_FIRST_LAYER_CELL_FRACTION = 0.5

function positive(name, value) {
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${name} must be a positive number, got ${JSON.stringify(value)}`)
  return number
}

/** Which flat-plate correlation applies at this Reynolds number. */
export function cfModel(Re) {
  const re = Number(Re)
  if (!Number.isFinite(re) || re <= 0) throw new Error(`Re must be a positive number, got ${JSON.stringify(Re)}`)
  return re < RE_TRANSITION ? 'laminar-blasius' : 'turbulent-1/7'
}

/**
 * Flat-plate skin friction coefficient.
 * Laminar Blasius below Re 5e5 (`laminarCfx`), the turbulent 1/7-power law above; `options.model` forces one.
 */
export function skinFriction(Re, options = {}) {
  const re = Number(Re)
  const model = options.model ?? cfModel(re)
  if (model === 'laminar-blasius') return 2 * 0.332 * Math.pow(re, -0.5) // 0.664·Re^(-1/2), local Cf_x
  if (model !== 'turbulent-1/7') throw new Error(`unknown skin-friction model ${JSON.stringify(model)}`)
  return 0.026 * Math.pow(re, -1 / 7)
}

/** Friction velocity from the free-stream speed and the skin friction coefficient. */
export function frictionVelocity({ uRef, re, legacyCf = false }) {
  const model = legacyCf ? 'turbulent-1/7' : undefined
  return uRef * Math.sqrt(skinFriction(re, { model }) / 2)
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
  const legacyYPlus = options.legacyYPlus === true

  const re = (uRef * lRef) / nu
  const model = legacyYPlus ? 'turbulent-1/7' : cfModel(re)
  const cf = skinFriction(re, { model })
  const uTau = uRef * Math.sqrt(cf / 2)
  const delta = 0.37 * lRef * Math.pow(re, -0.2)
  const factor = legacyYPlus ? 1 : CELL_THICKNESS_FACTOR
  const wallDistance = (yPlusTarget * nu) / uTau
  const firstLayerRequested = factor * wallDistance
  const notes = []
  let firstLayer = firstLayerRequested
  let clamped = false
  let clampNote = null
  if (cellSize != null && firstLayer > MAX_FIRST_LAYER_CELL_FRACTION * cellSize) {
    firstLayer = MAX_FIRST_LAYER_CELL_FRACTION * cellSize
    clamped = true
    clampNote = `first layer ${(firstLayerRequested * 1e6).toFixed(2)} µm exceeds half the near-wall cell `
      + `(${(cellSize * 1e6).toFixed(2)} µm): clamped to ${(firstLayer * 1e6).toFixed(2)} µm, which gives y+ `
      + `${((firstLayer / factor) * uTau / nu).toFixed(3)} instead of ${yPlusTarget} — refine the surface or raise the y+ target`
    notes.push(clampNote)
  }
  if (legacyYPlus) {
    notes.push('legacyYPlus: cell height = the y+ wall distance, turbulent Cf at every Re and no clamp — numbers match releases before 1.3.0')
  } else if (model === 'laminar-blasius') {
    notes.push(`Re ${re.toFixed(0)} is below ${RE_TRANSITION}: laminar Blasius Cf = 0.664/√Re is used (the earlier code used the turbulent 1/7-power law here); a y+ target usually means a turbulent boundary layer, so check the regime`)
  }
  const targetThickness = coverage * delta
  const nLayers = Math.max(1, Math.ceil(Math.log(1 + (targetThickness * (expansionRatio - 1)) / firstLayer) / Math.log(expansionRatio)))
  const totalThickness = (firstLayer * (Math.pow(expansionRatio, nLayers) - 1)) / (expansionRatio - 1)
  const lastLayer = firstLayer * Math.pow(expansionRatio, nLayers - 1)

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
    wallDistance_m: wallDistance,
    firstLayerRequested_m: firstLayerRequested,
    firstLayer_m: firstLayer,
    clamped,
    nLayers,
    expansionRatio,
    coverage,
    totalThickness_m: totalThickness,
    lastLayer_m: lastLayer,
    yPlusFirst: (firstLayer / factor) * uTau / nu,
    yPlusLast: (lastLayer * uTau) / nu / factor,
    formula: {
      cfModel: model,
      regime: model === 'laminar-blasius' ? 'laminar' : 'turbulent',
      cellThicknessFactor: factor,
      legacy: legacyYPlus,
      maxFirstLayerCellFraction: MAX_FIRST_LAYER_CELL_FRACTION,
    },
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
export function firstLayerFromYPlus({ yPlus, yPlusTarget, uRef, lRef, nu, legacyYPlus = false }) {
  return computeFirstLayer({ uRef, lRef, nu, yPlusTarget: yPlus ?? yPlusTarget ?? 1, legacyYPlus })
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
  const legacyYPlus = options.legacyYPlus === true
  const re = (uRef * lRef) / nu
  const model = legacyYPlus ? 'turbulent-1/7' : cfModel(re)
  const cf = skinFriction(re, { model })
  const uTau = uRef * Math.sqrt(cf / 2)
  const factor = legacyYPlus ? 1 : CELL_THICKNESS_FACTOR
  const wallDistance = firstLayer / factor
  // y+ is a centroid quantity: the first cell is `factor` times the wall distance that carries it
  const yPlus = (wallDistance * uTau) / nu
  const yPlusCellHeight = (firstLayer * uTau) / nu
  const delta = 0.37 * lRef * Math.pow(re, -0.2)
  const notes = []
  if (firstLayer > delta / 10) notes.push(`firstLayer ${(firstLayer * 1e3).toFixed(4)} mm is more than delta/10 (${(delta / 10 * 1e3).toFixed(4)} mm): resolving the wall is questionable`)
  if (yPlus > 300) notes.push(`y+ ${yPlus.toFixed(1)} is far above the wall-function range — a wall-function model may be the better choice`)
  if (legacyYPlus) notes.push('legacyYPlus: y+ from the full cell height (pre-1.3 convention)')
  else notes.push(`y+ ${yPlus.toFixed(3)} is measured at the cell centroid (half the ${(firstLayer * 1e6).toFixed(2)} µm cell); using the full height would report ${yPlusCellHeight.toFixed(3)}`)
  return {
    ok: true,
    input: { uRef, lRef, nu, firstLayer },
    Re: re,
    Cf: cf,
    uTau,
    delta_m: delta,
    wallDistance_m: wallDistance,
    firstLayer_m: firstLayer,
    yPlus,
    yPlusCellHeight,
    formula: { cfModel: model, regime: model === 'laminar-blasius' ? 'laminar' : 'turbulent', cellThicknessFactor: factor, legacy: legacyYPlus },
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
