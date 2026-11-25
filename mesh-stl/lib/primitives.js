/**
 * mesh-stl/lib/primitives.js — portable STL primitives, no Python and no project data.
 *
 * These are deliberately boring convex bodies (box, sphere, cylinder): they give every
 * plugin user a geometry to test the meshing route with, without a CAD kernel. Units
 * follow the project STL contract: millimetres, one closed shell, outward normals.
 * @module mesh-stl/lib/primitives
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const SHAPES = ['box', 'sphere', 'cylinder']

/** Numeric option with a default; throws on a non-numeric value. */
function num(value, fallback, label) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number, got ${value}`)
  return parsed
}

/**
 * Orient every triangle outward for a convex body: the normal must point away from the
 * shape centre. Winding from the mesh topology is not trusted here.
 */
function orientOutward(triangles, center) {
  return triangles.map(([a, b, c]) => {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const normal = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const mid = [(a[0] + b[0] + c[0]) / 3 - center[0], (a[1] + b[1] + c[1]) / 3 - center[1], (a[2] + b[2] + c[2]) / 3 - center[2]]
    const dot = normal[0] * mid[0] + normal[1] * mid[1] + normal[2] * mid[2]
    return dot >= 0 ? [a, b, c] : [a, c, b]
  })
}

/** Box centred at `center`, sizes in mm. */
function boxTriangles(size, center) {
  const [sx, sy, sz] = size.map((s) => s / 2)
  const [cx, cy, cz] = center
  const v = [
    [cx - sx, cy - sy, cz - sz], [cx + sx, cy - sy, cz - sz], [cx + sx, cy + sy, cz - sz], [cx - sx, cy + sy, cz - sz],
    [cx - sx, cy - sy, cz + sz], [cx + sx, cy - sy, cz + sz], [cx + sx, cy + sy, cz + sz], [cx - sx, cy + sy, cz + sz],
  ]
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 4, 7, 3], [1, 2, 6, 5], [0, 1, 5, 4], [3, 7, 6, 2],
  ]
  const tris = []
  for (const [a, b, c, d] of quads) {
    tris.push([v[a], v[b], v[c]], [v[a], v[c], v[d]])
  }
  return tris
}

/** UV sphere centred at `center`; poles are triangles, the rest quads. */
function sphereTriangles(radius, segments, rings, center) {
  const [cx, cy, cz] = center
  const point = (i, j) => {
    const theta = (Math.PI * i) / rings
    const phi = (2 * Math.PI * j) / segments
    return [
      cx + radius * Math.sin(theta) * Math.cos(phi),
      cy + radius * Math.sin(theta) * Math.sin(phi),
      cz + radius * Math.cos(theta),
    ]
  }
  const tris = []
  for (let i = 0; i < rings; i += 1) {
    for (let j = 0; j < segments; j += 1) {
      const a = point(i, j)
      const b = point(i, j + 1)
      const c = point(i + 1, j + 1)
      const d = point(i + 1, j)
      if (i === 0) tris.push([a, c, d])
      else if (i === rings - 1) tris.push([a, b, c])
      else tris.push([a, b, c], [a, c, d])
    }
  }
  return tris
}

/** Z-axis cylinder centred at `center`; side quads plus two fan caps. */
function cylinderTriangles(radius, height, sections, center) {
  const [cx, cy, cz] = center
  const z0 = cz - height / 2
  const z1 = cz + height / 2
  const tris = []
  const ring = (z) => Array.from({ length: sections }, (_, j) => {
    const phi = (2 * Math.PI * j) / sections
    return [cx + radius * Math.cos(phi), cy + radius * Math.sin(phi), z]
  })
  const bottom = ring(z0)
  const top = ring(z1)
  const bottomCenter = [cx, cy, z0]
  const topCenter = [cx, cy, z1]
  for (let j = 0; j < sections; j += 1) {
    const j2 = (j + 1) % sections
    tris.push([bottom[j], bottom[j2], top[j2]], [bottom[j], top[j2], top[j]])
    tris.push([bottomCenter, bottom[j2], bottom[j]])
    tris.push([topCenter, top[j], top[j2]])
  }
  return tris
}

/** Binary STL: 80-byte header, uint32 count, then (normal, 3 vertices, attribute). */
export function writeBinaryStl(file, triangles) {
  const buffer = Buffer.alloc(84 + triangles.length * 50)
  buffer.write('mesh-stl primitives', 0, 'utf8')
  buffer.writeUInt32LE(triangles.length, 80)
  let offset = 84
  for (const [a, b, c] of triangles) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    const len = Math.hypot(n[0], n[1], n[2]) || 1
    for (const value of [...n.map((x) => x / len), ...a, ...b, ...c]) {
      buffer.writeFloatLE(value, offset)
      offset += 4
    }
    offset += 2
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, buffer)
  return { file, triangles: triangles.length, bytes: buffer.length }
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
