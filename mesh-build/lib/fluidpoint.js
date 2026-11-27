/**
 * `mesh-build/lib/fluidpoint.js` — a fluid point from the geometry, in JS.
 *
 * `scripts/fluid-point.py` already did this with numpy, which made the advice "pick a fluid point"
 * impossible for anyone without the python bridge (D-8). This module is the portable path: read the
 * STLs, index the triangles in a uniform grid, sample a lattice over the domain and keep the point
 * that is outside every solid and as far from the walls as it gets.
 *
 * Classification uses the nearest triangle and its winding: the dot product of `point - closest`
 * with the triangle normal is positive outside a closed, consistently wound surface. That is the
 * same test the python helper uses, and it is only as good as the STL contract (`stl_check` must
 * PASS) — for a non-watertight surface the answer is a guess, so callers report the source.
 *
 * @module mesh-build/lib/fluidpoint
 */
import { readTriangles } from './surfacecheck.js'

const DEFAULTS = {
  clearance_mm: 0.1,
  samples: 18,
  seed: 1,
  maxSeconds: 20,
}

/** Deterministic 32-bit PRNG (mulberry32) — a repeatable sampling pattern, not real randomness. */
function rng(seed) {
  let a = (Number(seed) || 1) >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Axis-aligned bbox of a flat triangle list (metres). */
export function trianglesBbox(flat) {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i + 2 < flat.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      if (flat[i + k] < min[k]) min[k] = flat[i + k]
      if (flat[i + k] > max[k]) max[k] = flat[i + k]
    }
  }
  return { min, max }
}

/** Squared distance from a point to triangle `(a,b,c)`; Ericson, "Real-Time Collision Detection". */
function distanceSqToTriangle(p, ax, ay, az, bx, by, bz, cx, cy, cz) {
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz
  const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3)
    const dx = apx - v * abx, dy = apy - v * aby, dz = apz - v * abz
    return dx * dx + dy * dy + dz * dz
  }
  const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6)
    const dx = apx - w * acx, dy = apy - w * acy, dz = apz - w * acz
    return dx * dx + dy * dy + dz * dz
  }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    const dx = bpx + w * (cpx - bpx), dy = bpy + w * (cpy - bpy), dz = bpz + w * (cpz - bpz)
    return dx * dx + dy * dy + dz * dz
  }
  const denom = 1 / (va + vb + vc)
  const v = vb * denom
  const w = vc * denom
  const dx = apx - (v * abx + w * acx), dy = apy - (v * aby + w * acy), dz = apz - (v * abz + w * acz)
  return dx * dx + dy * dy + dz * dz
}

/** Uniform grid over the triangles, so a query touches a handful of them. */
function buildIndex(flat, bbox, cellsPerSide = 20) {
  const extent = [0, 1, 2].map((k) => Math.max(bbox.max[k] - bbox.min[k], 1e-12))
  const cell = Math.max(...extent) / Math.max(1, cellsPerSide)
  const key = (i, j, k) => `${i},${j},${k}`
  const grid = new Map()
  const cellOf = (v, k) => Math.floor((v - bbox.min[k]) / cell)
  for (let t = 0; t + 8 < flat.length; t += 9) {
    const xs = [flat[t], flat[t + 3], flat[t + 6]]
    const ys = [flat[t + 1], flat[t + 4], flat[t + 7]]
    const zs = [flat[t + 2], flat[t + 5], flat[t + 8]]
    const lo = [Math.min(...xs), Math.min(...ys), Math.min(...zs)]
    const hi = [Math.max(...xs), Math.max(...ys), Math.max(...zs)]
    for (let i = cellOf(lo[0], 0); i <= cellOf(hi[0], 0); i += 1) {
      for (let j = cellOf(lo[1], 1); j <= cellOf(hi[1], 1); j += 1) {
        for (let k = cellOf(lo[2], 2); k <= cellOf(hi[2], 2); k += 1) {
          const bucket = grid.get(key(i, j, k))
          if (bucket) bucket.push(t)
          else grid.set(key(i, j, k), [t])
        }
      }
    }
  }
  // how many cells each axis has, so a query outside the geometry can start from the nearest cell
  const dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil(extent[k] / cell)))
  return { grid, cell, key, cellOf, bbox, dims }
}

/**
 * Nearest triangle to a point: `{ distance, normal, offset }` where `offset` is the signed dot of
 * `point - closest` with the triangle normal (positive = outside a closed surface).
 */
function nearestTriangle(flat, index, p) {
  const { grid, cell, key, cellOf, dims, bbox } = index
  // Outside the geometry's own bounding box a closed surface cannot contain the point, and the
  // distance to the surface is at least the distance to the box: answer without a ring search.
  const outsideDist = [0, 1, 2].reduce((sum, k) => {
    const d = p[k] < bbox.min[k] ? bbox.min[k] - p[k] : p[k] > bbox.max[k] ? p[k] - bbox.max[k] : 0
    return sum + d * d
  }, 0)
  if (outsideDist > 0) {
    const closest = [0, 1, 2].map((k) => Math.min(bbox.max[k], Math.max(bbox.min[k], p[k])))
    return { distance: Math.sqrt(outsideDist), normal: [0, 0, 0], closest, offset: 1 }
  }
  const clamp = (i, k) => Math.min(dims[k] - 1, Math.max(0, i))
  const base = [clamp(cellOf(p[0], 0), 0), clamp(cellOf(p[1], 1), 1), clamp(cellOf(p[2], 2), 2)]
  const maxRing = 8
  let best = null
  for (let ring = 0; ring <= maxRing; ring += 1) {
    for (let i = base[0] - ring; i <= base[0] + ring; i += 1) {
      for (let j = base[1] - ring; j <= base[1] + ring; j += 1) {
        for (let k = base[2] - ring; k <= base[2] + ring; k += 1) {
          const onShell = Math.abs(i - base[0]) === ring || Math.abs(j - base[1]) === ring || Math.abs(k - base[2]) === ring
          if (!onShell) continue
          const bucket = grid.get(key(i, j, k))
          if (!bucket) continue
          for (const t of bucket) {
            const d2 = distanceSqToTriangle(p, flat[t], flat[t + 1], flat[t + 2], flat[t + 3], flat[t + 4], flat[t + 5], flat[t + 6], flat[t + 7], flat[t + 8])
            if (!best || d2 < best.d2) {
              const ax = flat[t], ay = flat[t + 1], az = flat[t + 2]
              const bx = flat[t + 3], by = flat[t + 4], bz = flat[t + 5]
              const cx = flat[t + 6], cy = flat[t + 7], cz = flat[t + 8]
              const ux = bx - ax, uy = by - ay, uz = bz - az
              const vx = cx - ax, vy = cy - ay, vz = cz - az
              let nx = uy * vz - uz * vy
              let ny = uz * vx - ux * vz
              let nz = ux * vy - uy * vx
              const len = Math.hypot(nx, ny, nz) || 1
              nx /= len; ny /= len; nz /= len
              best = { d2, t, normal: [nx, ny, nz], tri: { a: [ax, ay, az], b: [bx, by, bz], c: [cx, cy, cz] } }
            }
          }
        }
      }
    }
    if (best && best.d2 <= (ring * cell) ** 2) break
  }
  if (!best) return null
  // closest point on the best triangle, then the signed offset
  const { a, b, c } = best.tri
  const abx = b[0] - a[0], aby = b[1] - a[1], abz = b[2] - a[2]
  const acx = c[0] - a[0], acy = c[1] - a[1], acz = c[2] - a[2]
  const apx = p[0] - a[0], apy = p[1] - a[1], apz = p[2] - a[2]
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  const denom = abx * abx + aby * aby + abz * abz
  const denom2 = acx * acx + acy * acy + acz * acz
  const cross = abx * acx + aby * acy + abz * acz
  let v = 0
  let w = 0
  const det = denom * denom2 - cross * cross
  if (Math.abs(det) > 1e-30) {
    v = (d1 * denom2 - d2 * cross) / det
    w = (d2 * denom - d1 * cross) / det
  }
  v = Math.max(0, Math.min(1, v))
  w = Math.max(0, Math.min(1 - v, w))
  const closest = [a[0] + v * abx + w * acx, a[1] + v * aby + w * acy, a[2] + v * abz + w * acz]
  const offset = (p[0] - closest[0]) * best.normal[0] + (p[1] - closest[1]) * best.normal[1] + (p[2] - closest[2]) * best.normal[2]
  return { distance: Math.sqrt(best.d2), normal: best.normal, closest, offset }
}

/**
 * Pick a point that is outside every solid and as far from the walls as the lattice offers.
 * @param {string[]} stlPaths STL files, millimetres, one solid surface each (fluid or solid matter)
 * @param {{domainMin?: number[], domainMax?: number[], clearance_mm?: number, samples?: number,
 *   seed?: number, maxSeconds?: number, avoid?: Array<{point: number[], radius: number}>}} [options]
 */
export function suggestFluidPoint(stlPaths, options = {}) {
  const started = Date.now()
  const files = Array.isArray(stlPaths) ? stlPaths.filter(Boolean) : [stlPaths].filter(Boolean)
  if (!files.length) return { ok: false, reason: 'no STL to read' }
  const flat = []
  for (const file of files) {
    const tris = readTriangles(file)
    for (let i = 0; i < tris.length; i += 9) {
      flat.push(tris[i] / 1000, tris[i + 1] / 1000, tris[i + 2] / 1000)
    }
  }
  if (flat.length < 9) return { ok: false, reason: 'the STL has no triangles' }
  const geo = trianglesBbox(flat)
  const clearance = Number(options.clearance_mm ?? DEFAULTS.clearance_mm) / 1000
  const samples = Math.max(4, Math.min(40, Math.floor(Number(options.samples ?? DEFAULTS.samples))))
  const maxSeconds = Number(options.maxSeconds ?? DEFAULTS.maxSeconds)
  const domainMin = Array.isArray(options.domainMin) ? options.domainMin : geo.min
  const domainMax = Array.isArray(options.domainMax) ? options.domainMax : geo.max
  const index = buildIndex(flat, geo)
  const rand = rng(options.seed ?? DEFAULTS.seed)
  // lattice + a deterministic jitter so the point is not glued to a cell centre
  const step = [0, 1, 2].map((k) => (domainMax[k] - domainMin[k]) / (samples - 1))
  let best = null
  let tested = 0
  for (let i = 0; i < samples; i += 1) {
    for (let j = 0; j < samples; j += 1) {
      for (let k = 0; k < samples; k += 1) {
        if ((tested & 0xff) === 0 && (Date.now() - started) / 1000 > maxSeconds) return { ok: false, reason: `no point found within ${maxSeconds}s` }
        tested += 1
        const p = [
          domainMin[0] + i * step[0] + (rand() - 0.5) * step[0] * 0.5,
          domainMin[1] + j * step[1] + (rand() - 0.5) * step[1] * 0.5,
          domainMin[2] + k * step[2] + (rand() - 0.5) * step[2] * 0.5,
        ]
        const margin = Math.min(
          p[0] - domainMin[0], domainMax[0] - p[0],
          p[1] - domainMin[1], domainMax[1] - p[1],
          p[2] - domainMin[2], domainMax[2] - p[2],
        )
        if (margin <= clearance) continue
        const near = nearestTriangle(flat, index, p)
        if (!near) continue
        if (near.offset <= 0) continue // inside a solid
        if (near.distance < clearance) continue
        if (Array.isArray(options.avoid)) {
          const blocked = options.avoid.some((zone) => Math.hypot(p[0] - zone.point[0], p[1] - zone.point[1], p[2] - zone.point[2]) < Number(zone.radius ?? 0))
          if (blocked) continue
        }
        if (!best || near.distance > best.clearance) best = { point: p, clearance: near.distance }
      }
    }
  }
  if (!best) {
    return { ok: false, reason: `no point at least ${options.clearance_mm ?? DEFAULTS.clearance_mm} mm from every wall and inside the domain`, tested }
  }
  return {
    ok: true,
    point_m: best.point,
    point_mm: best.point.map((v) => Number((v * 1000).toPrecision(6))),
    clearance_mm: Number((best.clearance * 1000).toPrecision(4)),
    tested,
    samples,
    seed: options.seed ?? DEFAULTS.seed,
    source: 'lattice+nearest-triangle',
  }
}
