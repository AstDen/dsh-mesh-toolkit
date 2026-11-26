/**
 * mesh-stl/lib/primitives.js — portable STL primitives, no Python and no project data.
 *
 * Deliberately boring closed bodies (box, sphere, cylinder, cone, pipe) plus a `parts[]` assembly:
 * they give every plugin user a geometry to test a meshing route with, without a CAD kernel. Units
 * follow the project STL contract: millimetres, closed shells, outward normals.
 * Triangle emitters live in `./shapes.js` and are shared with the other built-ins.
 * @module mesh-stl/lib/primitives
 */
import {
  boxTriangles,
  coneTriangles,
  cylinderTriangles,
  orientOutward,
  pipeTriangles,
  sphereTriangles,
  transformTriangles,
  writeBinaryStl,
} from './shapes.js'

export { writeBinaryStl }

/** Single-body shapes (`parts[]` is the assembly form, not a shape). */
export const PRIMITIVE_SHAPES = ['box', 'sphere', 'cylinder', 'cone', 'pipe']

/** Numeric option with a default; throws on a non-numeric value. */
function num(value, fallback, label, { allowZero = false } = {}) {
  if (value === undefined || value === null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || (!allowZero && parsed === 0)) {
    throw new Error(`${label} must be a ${allowZero ? 'non-negative' : 'positive'} number, got ${value}`)
  }
  return parsed
}

function vector3(value, fallback, label) {
  if (value === undefined || value === null) return fallback
  if (!Array.isArray(value) || value.length !== 3 || value.some((v) => !Number.isFinite(Number(v)))) {
    throw new Error(`${label} must be three numbers, got ${JSON.stringify(value)}`)
  }
  return value.map(Number)
}

/**
 * Triangles and the analytic volume of ONE body, centred at its own `center_mm`
 * (a `parts[]` entry is built first, then transformed as a rigid body).
 */
function bodyTriangles(part) {
  const shape = String(part.shape ?? 'box').toLowerCase()
  if (!PRIMITIVE_SHAPES.includes(shape)) {
    throw new Error(`primitive shape must be one of ${PRIMITIVE_SHAPES.join(', ')}, got ${shape}`)
  }
  const center = vector3(part.center_mm, [0, 0, 0], 'center_mm')
  if (shape === 'box') {
    const size = vector3(part.size_mm, [10, 10, 10], 'size_mm')
    if (size.some((value) => value <= 0)) throw new Error('size_mm must be three positive numbers')
    return { shape, center, triangles: orientOutward(boxTriangles(size, center), center), volumeMm3: size[0] * size[1] * size[2] }
  }
  if (shape === 'sphere') {
    const radius = num(part.radius_mm, 5, 'radius_mm')
    const segments = Math.max(6, Math.round(num(part.segments, 32, 'segments')))
    const rings = Math.max(3, Math.round(num(part.rings, 16, 'rings')))
    return {
      shape,
      center,
      triangles: orientOutward(sphereTriangles(radius, segments, rings, center), center),
      volumeMm3: (4 / 3) * Math.PI * radius ** 3,
    }
  }
  if (shape === 'cylinder') {
    const radius = num(part.radius_mm, 3, 'radius_mm')
    const height = num(part.height_mm, 10, 'height_mm')
    const sections = Math.max(6, Math.round(num(part.sections, 48, 'sections')))
    return {
      shape,
      center,
      triangles: orientOutward(cylinderTriangles(radius, height, sections, center), center),
      volumeMm3: Math.PI * radius ** 2 * height,
    }
  }
  const height = num(part.height_mm, 10, 'height_mm')
  const sections = Math.max(6, Math.round(num(part.sections, 48, 'sections')))
  if (shape === 'cone') {
    const r1 = num(part.radius_bottom_mm, 3, 'radius_bottom_mm')
    const r2 = num(part.radius_top_mm, 0, 'radius_top_mm', { allowZero: true })
    const triangles = orientOutward(coneTriangles(r1, r2, height, sections, center), center)
    return { shape, center, triangles, volumeMm3: (Math.PI * height * (r1 * r1 + r1 * r2 + r2 * r2)) / 3 }
  }
  // pipe: a hollow cylinder is not convex, `pipeTriangles` orients each surface itself
  const rOuter = num(part.radius_outer_mm, 3, 'radius_outer_mm')
  const rInner = num(part.radius_inner_mm, 2, 'radius_inner_mm')
  if (rInner >= rOuter) throw new Error(`pipe needs radius_inner_mm < radius_outer_mm, got ${rInner} >= ${rOuter}`)
  return {
    shape,
    center,
    triangles: pipeTriangles(rOuter, rInner, height, sections, center),
    volumeMm3: Math.PI * height * (rOuter ** 2 - rInner ** 2),
  }
}

/**
 * Build one primitive or a `parts[]` assembly from params.
 * Assembly entries accept the same shape parameters plus `translate_mm`, `rotate_deg` and `scale`.
 * @param {object} params primitive parameters (see README) or `{ parts: [...] }`
 * @param {string} file target STL
 */
export function buildPrimitive(params, file) {
  const parts = Array.isArray(params.parts) ? params.parts : null
  if (parts && parts.length === 0) throw new Error('parts[] is empty: give at least one body or omit it')
  const written = (() => {
    if (parts) {
      const built = parts.map((part, index) => {
        if (!part || typeof part !== 'object') throw new Error(`parts[${index}] must be an object`)
        const body = bodyTriangles(part)
        const scale = Number(part.scale ?? 1)
        if (!Number.isFinite(scale) || scale <= 0) throw new Error(`parts[${index}].scale must be a positive number, got ${part.scale}`)
        const triangles = transformTriangles(body.triangles, {
          translate: vector3(part.translate_mm ?? part.translate, [0, 0, 0], `parts[${index}].translate_mm`),
          rotate_deg: vector3(part.rotate_deg, [0, 0, 0], `parts[${index}].rotate_deg`),
          scale,
        })
        return { shape: body.shape, triangles, volumeMm3: body.volumeMm3 * scale ** 3 }
      })
      const triangles = built.flatMap((body) => body.triangles)
      return {
        ...writeBinaryStl(file, triangles),
        shape: 'parts',
        parts: built.map((body) => body.shape),
        volume_mm3_theory: built.reduce((sum, body) => sum + body.volumeMm3, 0),
        units: 'mm',
      }
    }
    const body = bodyTriangles(params)
    const scale = Number(params.scale ?? 1)
    if (!Number.isFinite(scale) || scale <= 0) throw new Error(`scale must be a positive number, got ${params.scale}`)
    const triangles = transformTriangles(body.triangles, {
      translate: vector3(params.translate_mm ?? params.translate, [0, 0, 0], 'translate_mm'),
      rotate_deg: vector3(params.rotate_deg, [0, 0, 0], 'rotate_deg'),
      scale,
    })
    return {
      ...writeBinaryStl(file, triangles),
      shape: body.shape,
      center_mm: body.center,
      volume_mm3_theory: body.volumeMm3 * scale ** 3,
      units: 'mm',
    }
  })()
  return written
}
