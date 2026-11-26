/**
 * mesh-stl/lib/primitives.js — portable STL primitives, no Python and no project data.
 *
 * These are deliberately boring convex bodies (box, sphere, cylinder): they give every
 * plugin user a geometry to test the meshing route with, without a CAD kernel. Units
 * follow the project STL contract: millimetres, one closed shell, outward normals.
 * Triangle emitters live in `./shapes.js` and are shared with the other built-ins.
 * @module mesh-stl/lib/primitives
 */
import { boxTriangles, cylinderTriangles, orientOutward, sphereTriangles, writeBinaryStl } from './shapes.js'

export { writeBinaryStl }

const SHAPES = ['box', 'sphere', 'cylinder']

/** Numeric option with a default; throws on a non-numeric value. */
function num(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number, got ${value}`)
  return parsed
}

/**
 * Build one primitive from params.
 * @param {{shape?: string, size_mm?: number[], radius_mm?: number, height_mm?: number,
 *   center_mm?: number[], segments?: number, rings?: number, sections?: number}} params
 * @param {string} file target STL
 */
export function buildPrimitive(params, file) {
  const shape = String(params.shape ?? 'box').toLowerCase()
  if (!SHAPES.includes(shape)) throw new Error(`primitive shape must be one of ${SHAPES.join(', ')}, got ${shape}`)
  const center = Array.isArray(params.center_mm) && params.center_mm.length === 3
    ? params.center_mm.map(Number)
    : [0, 0, 0]
  if (center.some((value) => !Number.isFinite(value))) throw new Error('center_mm must be three numbers')
  let triangles
  let volumeMm3
  if (shape === 'box') {
    const size = Array.isArray(params.size_mm) && params.size_mm.length === 3 ? params.size_mm.map(Number) : [10, 10, 10]
    if (size.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error('size_mm must be three positive numbers')
    triangles = boxTriangles(size, center)
    volumeMm3 = size[0] * size[1] * size[2]
  } else if (shape === 'sphere') {
    const radius = num(params.radius_mm, 5, 'radius_mm')
    const segments = Math.max(6, Math.round(num(params.segments, 32, 'segments')))
    const rings = Math.max(3, Math.round(num(params.rings, 16, 'rings')))
    triangles = sphereTriangles(radius, segments, rings, center)
    volumeMm3 = (4 / 3) * Math.PI * radius ** 3
  } else {
    const radius = num(params.radius_mm, 3, 'radius_mm')
    const height = num(params.height_mm, 10, 'height_mm')
    const sections = Math.max(6, Math.round(num(params.sections, 48, 'sections')))
    triangles = cylinderTriangles(radius, height, sections, center)
    volumeMm3 = Math.PI * radius ** 2 * height
  }
  const written = writeBinaryStl(file, orientOutward(triangles, center))
  return { ...written, shape, center_mm: center, volume_mm3_theory: volumeMm3, units: 'mm' }
}
