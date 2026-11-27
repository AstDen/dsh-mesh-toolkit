/**
 * mesh-build/lib/minvol.js — derive the absolute `minVol` gate threshold from the case itself.
 *
 * `minVol` in `meshQualityDict` is the volume of the face–cell-centre pyramid (m³), so a
 * profile-wide constant is meaningless: the right value follows the smallest intended cell,
 * `h_min³/6`. That cell size is knowable from the case: the handoff records
 * `selection.cellSize_m` and the refinement levels, and the scaffold knows both before the
 * handoff exists. A mean cell size is deliberately NOT used — it overestimates `h_min`, and a
 * too-large `minVol` raises false alarms, which is worse than a disabled check.
 * @module mesh-build/lib/minvol
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readHandoff } from '../../sim-core/lib/handoff.js'

function finiteNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Largest refinement level mentioned in the handoff (`levels` holds arrays per patch). */
export function maxLevelOf(levels) {
  let max = 0
  for (const value of Object.values(levels ?? {})) {
    const list = Array.isArray(value) ? value : [value]
    for (const item of list) {
      if (Number.isInteger(item) && item > max) max = item
    }
  }
  return max
}

/**
 * Derive `h_min³/6` from the case.
 * @param {string} caseDir absolute case directory
 * @returns {{minVol: number, hMin: number, source: string, note: string}|null}
 */
function caseDictMinVol(caseDir) {
  const file = join(caseDir, 'system', 'meshQualityDict')
  if (!existsSync(file)) return null
  const text = readFileSync(file, 'utf8')
  const m = text.replace(/\/\/.*$/gm, '').match(/^\s*minVol\s+([-+0-9.eE]+)\s*;/m)
  const value = m ? Number(m[1]) : NaN
  return Number.isFinite(value) && value > 0 ? value : null
}

export function deriveMinVol(caseDir) {
  const handoff = readHandoff(caseDir)
  const cellSize = finiteNumber(handoff?.selection?.cellSize_m)
  if (cellSize) {
    const level = maxLevelOf(handoff?.levels)
    const hMin = cellSize / 2 ** level
    return {
      minVol: (hMin ** 3) / 6,
      hMin,
      source: 'handoff-cellSize',
      note: `h_min = ${cellSize} m / 2^${level} (handoff selection.cellSize_m and refinement levels)`,
    }
  }

  // A scaffolded case records the snappy-internal threshold it wrote; when no handoff exists
  // (first check on an external case) that number is still a real absolute volume.
  const fromDict = caseDictMinVol(caseDir)
  if (fromDict) {
    return { minVol: fromDict, hMin: Math.cbrt(fromDict * 6), source: 'case-meshQualityDict', note: 'minVol read from system/meshQualityDict (written by the scaffold)' }
  }
  return null
}

/**
 * `minVol = h_min³/6` from a scaffold setup (cell size + the deepest refinement level).
 * @param {{cellSize_m?: number|string, levels?: object}|null} setup
 */
export function minVolFromSetup(setup) {
  const cellSize = finiteNumber(setup?.cellSize_m)
  if (!cellSize) return null
  const level = maxLevelOf(setup?.levels)
  const hMin = cellSize / 2 ** level
  return {
    minVol: (hMin ** 3) / 6,
    hMin,
    source: 'scaffold-cellSize',
    note: `h_min = ${cellSize} m / 2^${level} (scaffold cellSize and refinement levels)`,
  }
}
