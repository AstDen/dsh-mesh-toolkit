/**
 * mesh-build/lib/precheck.js — guards around a real build: silent clipping, silent
 * inverted fluid region, runaway background meshes, cfMesh unit mismatches.
 *
 * Every guard returns a message instead of throwing, so the caller decides the phase
 * (`scaffold` for warnings collected during scaffold, `preflight`/`sanity` for refusals).
 * Background: benchmark/runs/20261125-1805 (DEF-03, DEF-11, DEF-17, DEF-18).
 * @module mesh-build/lib/precheck
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const STL_MM_TO_M = 0.001

/** Bounding box of a BINARY STL in millimetres; null for ASCII or unreadable files. */
export function readBinaryStlBboxMm(file) {
  let buf
  try { buf = readFileSync(file) } catch { return null }
  if (buf.length < 84) return null
  const count = buf.readUInt32LE(80)
  if (!Number.isFinite(count) || buf.length !== 84 + count * 50) return null
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < count; i += 1) {
    const base = 84 + i * 50 + 12
    for (let v = 0; v < 3; v += 1) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = buf.readFloatLE(base + v * 12 + axis * 4)
        if (value < min[axis]) min[axis] = value
        if (value > max[axis]) max[axis] = value
      }
    }
  }
  if (!min.every(Number.isFinite)) return null
  return { min, max }
}

/** Bounding box of an ASCII STL in file units (mm); null when no vertices are found. */
function readAsciiStlBbox(file) {
  let text
  try { text = readFileSync(file, 'utf8') } catch { return null }
  if (!/vertex/i.test(text)) return null
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  const re = /vertex\s+(-?[0-9.eE+-]+)\s+(-?[0-9.eE+-]+)\s+(-?[0-9.eE+-]+)/g
  let match
  let seen = 0
  while ((match = re.exec(text)) !== null) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = Number(match[axis + 1])
      if (!Number.isFinite(value)) continue
      if (value < min[axis]) min[axis] = value
      if (value > max[axis]) max[axis] = value
    }
    seen += 1
  }
  if (seen === 0 || !min.every(Number.isFinite)) return null
  return { min, max, format: 'ascii' }
}

/** Bbox of any STL (binary preferred, ASCII fallback); null when unreadable. */
export function readStlBboxMm(file) {
  const binary = readBinaryStlBboxMm(file)
  if (binary) return { ...binary, format: 'binary' }
  return readAsciiStlBbox(file)
}

function fmtPoint(point) {
  return `(${point.map((v) => Number(v.toPrecision(6))).join(' ')})`
}

/**
 * Warning: an STL (mm) sticks out of the domain (m). snappyHexMesh then clips the surface
 * silently — the mesh looks valid, the geometry is not (benchmark E1 literal config).
 */
export function stlOutsideDomainWarning(name, bboxMm, domainMin, domainMax, tol = 1e-9) {
  if (!bboxMm) return null
  const min = bboxMm.min.map((v) => v * STL_MM_TO_M)
  const max = bboxMm.max.map((v) => v * STL_MM_TO_M)
  const outside = min.some((v, i) => v < domainMin[i] - tol) || max.some((v, i) => v > domainMax[i] + tol)
  if (!outside) return null
  return `STL "${name}" bbox ${fmtPoint(min)}…${fmtPoint(max)} m exceeds the domain `
    + `${fmtPoint(domainMin)}…${fmtPoint(domainMax)} m — snappyHexMesh clips the surface silently; `
    + 'enlarge domainMin/domainMax or check the units (STL mm, domain m)'
}

/** Warning: the background mesh alone exceeds the cell budget (DEF-18). */
export function cellBudgetWarning(cells, maxCells) {
  const total = cells.reduce((a, b) => a * b, 1)
  if (!Number.isFinite(maxCells) || maxCells <= 0 || total <= maxCells) return null
  return `background mesh alone would be ${total} cells (cells ${cells.join('x')}), above maxCells ${maxCells}: `
    + "this is the maxGlobalCells kind of budget — a run like this takes minutes and hundreds of MB; "
    + 'increase cellSize / lower cells, or pass maxCells explicitly to accept the cost'
}

function patchList(patches) {
  return patches.map((p) => `${p.name}(${p.type}, ${p.nFaces})`).join(', ')
}

/**
 * Problem: the background/domain patch is missing after meshing, i.e. snappy kept the
 * inside of a closed solid instead of the outside — locationInMesh landed in the solid (DEF-17).
 */
export function domainPatchProblem(patchReport, domainPatch = 'world') {
  const entries = Array.isArray(patchReport?.entries) ? patchReport.entries : []
  if (entries.length === 0) return null
  for (const entry of entries) {
    const patches = entry.patches ?? []
    if (patches.length === 0) continue
    const found = patches.find((p) => p.name === domainPatch)
    if (found && found.nFaces > 0) continue
    return `patch "${domainPatch}" is missing from the built mesh (patches: ${patchList(patches)}) — `
      + 'locationInMesh most likely landed inside the solid body, so snappy kept the solid interior; '
      + 'pick a fluid point (benchmark/scripts/fluid_point.py) and rebuild'
  }
  return null
}

/**
 * Problem: the cfMesh `meshDict` cell size is in different units than the STL. cfMesh has no
 * scale option: it derives the octree level from the surface bounding box, so a mm surface with
 * metre cell sizes asks for octree level ~17 and runs until the step timeout (DEF-03).
 */
export function cfmeshUnitsProblem(caseDir, stlFiles, maxOctreeLevel = 12) {
  const dictPath = join(caseDir, 'system', 'meshDict')
  let text
  try { text = readFileSync(dictPath, 'utf8') } catch { return null }
  const cellSize = text.match(/maxCellSize\s+([0-9.eE+-]+)\s*;/)
  if (!cellSize) return null
  const size = Number(cellSize[1])
  if (!Number.isFinite(size) || size <= 0) return null
  const boxes = stlFiles.map((file) => readStlBboxMm(file)).filter(Boolean)
  if (boxes.length === 0) return null
  const min = [0, 1, 2].map((axis) => Math.min(...boxes.map((b) => b.min[axis])))
  const max = [0, 1, 2].map((axis) => Math.max(...boxes.map((b) => b.max[axis])))
  const extent = Math.max(...max.map((v, i) => v - min[i]))
  const level = Math.log2(extent / size)
  if (!Number.isFinite(level) || level <= maxOctreeLevel) return null
  return `cfMesh would use octree level ${level.toFixed(1)} for maxCellSize ${size} on a surface of `
    + `${extent.toFixed(3)} file units (limit ${maxOctreeLevel}): the meshDict cell size and the STL are in `
    + "different units. Either give the cell size in the STL's units (mm -> 0.2 not 2e-4), or scale the STL "
    + "to metres: surfaceTransformPoints -scale '(0.001 0.001 0.001)' <in>.stl <out>.stl"
}
