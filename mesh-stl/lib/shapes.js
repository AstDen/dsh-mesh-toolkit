/**
 * mesh-stl/lib/shapes.js — closed convex bodies and the binary STL writer.
 *
 * Shared by the built-in JS generators (`primitive`, `stratified-channel`,
 * `box-array`): no Python, no CAD kernel, no project data. Units follow the STL
 * contract: millimetres, closed shells, outward normals.
 * @module mesh-stl/lib/shapes
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Orient every triangle outward for a convex body: the normal must point away from the
 * shape centre. Winding from the mesh topology is not trusted here.
 */
export function orientOutward(triangles, center) {
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
export function boxTriangles(size, center) {
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
export function sphereTriangles(radius, segments, rings, center) {
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
export function cylinderTriangles(radius, height, sections, center) {
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

/**
 * Cone / truncated cone (frustum) along Z: radius `r1` at the bottom, `r2` at the top.
 * `r2 = 0` collapses the top into an apex; `orientOutward` handles the winding of a convex body.
 */
export function coneTriangles(r1, r2, height, sections, center) {
  const [cx, cy, cz] = center
  const z0 = cz - height / 2
  const z1 = cz + height / 2
  const ring = (radius, z) => Array.from({ length: sections }, (_, j) => {
    const phi = (2 * Math.PI * j) / sections
    return [cx + radius * Math.cos(phi), cy + radius * Math.sin(phi), z]
  })
  const tris = []
  const bottom = ring(r1, z0)
  const apex = r2 <= 0
  const top = apex ? null : ring(r2, z1)
  const apexPoint = [cx, cy, z1]
  const bottomCenter = [cx, cy, z0]
  for (let j = 0; j < sections; j += 1) {
    const j2 = (j + 1) % sections
    if (apex) {
      tris.push([bottom[j], bottom[j2], apexPoint])
    } else {
      tris.push([bottom[j], bottom[j2], top[j2]], [bottom[j], top[j2], top[j]])
      tris.push([[cx, cy, z1], top[j], top[j2]])
    }
    tris.push([bottomCenter, bottom[j2], bottom[j]])
  }
  return tris
}

/**
 * Pipe (hollow cylinder, annular caps) along Z. Not convex: the inner wall must point toward the axis,
 * so the winding is fixed per surface against an expected direction instead of by `orientOutward`.
 */
export function pipeTriangles(rOuter, rInner, height, sections, center) {
  const [cx, cy, cz] = center
  const z0 = cz - height / 2
  const z1 = cz + height / 2
  const ring = (radius, z) => Array.from({ length: sections }, (_, j) => {
    const phi = (2 * Math.PI * j) / sections
    return [cx + radius * Math.cos(phi), cy + radius * Math.sin(phi), z]
  })
  const ob = ring(rOuter, z0); const ot = ring(rOuter, z1)
  const ib = ring(rInner, z0); const it = ring(rInner, z1)
  const raw = []
  for (let j = 0; j < sections; j += 1) {
    const j2 = (j + 1) % sections
    raw.push([ob[j], ob[j2], ot[j2], 'outer'])
    raw.push([ob[j], ot[j2], ot[j], 'outer'])
    raw.push([ib[j], it[j2], ib[j2], 'inner'])
    raw.push([ib[j], it[j], it[j2], 'inner'])
    raw.push([ob[j], ib[j], ib[j2], 'bottom'])
    raw.push([ob[j], ib[j2], ob[j2], 'bottom'])
    raw.push([ot[j], it[j2], it[j], 'top'])
    raw.push([ot[j], ot[j2], it[j2], 'top'])
  }
  const tris = []
  for (const [a, b, c, kind] of raw) {
    const n = normalOf(a, b, c)
    const mid = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]
    let expected
    if (kind === 'outer') expected = [mid[0] - cx, mid[1] - cy, 0]
    else if (kind === 'inner') expected = [cx - mid[0], cy - mid[1], 0]
    else if (kind === 'bottom' || kind === 'bottom-inner') expected = [0, 0, -1]
    else expected = [0, 0, 1]
    const dot = n[0] * expected[0] + n[1] * expected[1] + n[2] * expected[2]
    tris.push(dot >= 0 ? [a, b, c] : [a, c, b])
  }
  return tris
}

/** Triangle normal (not normalised). */
export function normalOf(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  return [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
}

/** Concatenate triangle lists (a `parts[]` assembly is one STL with several closed shells). */
export function mergeTriangles(lists) {
  return lists.flat()
}

/** Uniform scale, then rotation about the global axes in X→Y→Z order (degrees), then translation. */
export function transformTriangles(triangles, { translate = [0, 0, 0], rotate_deg = [0, 0, 0], scale = 1 } = {}) {
  const k = Number(scale)
  if (!Number.isFinite(k) || k <= 0) throw new Error(`scale must be a positive number, got ${scale}`)
  const [rx, ry, rz] = rotate_deg.map((value) => (Number(value) * Math.PI) / 180)
  const [tx, ty, tz] = translate.map(Number)
  if ([rx, ry, rz, tx, ty, tz].some((value) => !Number.isFinite(value))) throw new Error('translate must be three numbers and rotate_deg three degrees')
  const apply = ([x, y, z]) => {
    let px = x * k; let py = y * k; let pz = z * k
    // X
    let ny = py * Math.cos(rx) - pz * Math.sin(rx)
    let nz = py * Math.sin(rx) + pz * Math.cos(rx)
    py = ny; pz = nz
    // Y
    let nx = px * Math.cos(ry) + pz * Math.sin(ry)
    nz = -px * Math.sin(ry) + pz * Math.cos(ry)
    px = nx; pz = nz
    // Z
    nx = px * Math.cos(rz) - py * Math.sin(rz)
    ny = px * Math.sin(rz) + py * Math.cos(rz)
    px = nx; py = ny
    return [px + tx, py + ty, pz + tz]
  }
  return triangles.map((tri) => tri.map(apply))
}

/** Binary STL: 80-byte header, uint32 count, then (normal, 3 vertices, attribute). */
export function writeBinaryStl(file, triangles) {
  const buffer = Buffer.alloc(84 + triangles.length * 50)
  buffer.write('mesh-stl shapes', 0, 'utf8')
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
