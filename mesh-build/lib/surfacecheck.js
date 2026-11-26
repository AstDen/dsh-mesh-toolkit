/**
 * STL <-> surface-mesh fidelity check (workbench contract, plan A7).
 *
 * The mesh patches exported with `surfaceMeshTriangulate` are compared with the reference STL:
 * bounding box, area, volume and an approximate Hausdorff distance (triangle-centroid sampling of one
 * surface against the triangles of the other). A domain that clips the geometry shows up as a bbox
 * difference — the failure mode the benchmark recorded as DEF-11.
 */

import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const EPS = 1e-18

/** Read a binary or ASCII STL into a flat triangle list (9 numbers per triangle, file units). */
export function readTriangles(file) {
  const buffer = readFileSync(file)
  const text = buffer.subarray(0, 512).toString('latin1')
  const ascii = text.startsWith('solid') && text.includes('facet')
  const out = []
  if (ascii) {
    const body = buffer.toString('latin1')
    const vertices = [...body.matchAll(/vertex\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)/g)]
    if (!vertices.length) throw new Error(`ASCII STL has no "vertex" lines: ${file}`)
    if (vertices.length % 3 !== 0) throw new Error(`ASCII STL vertex count ${vertices.length} is not a multiple of 3: ${file}`)
    for (let i = 0; i < vertices.length; i += 3) {
      for (let k = 0; k < 3; k += 1) out.push(Number(vertices[i + k][1]), Number(vertices[i + k][2]), Number(vertices[i + k][3]))
    }
  } else {
    if (buffer.length < 84) throw new Error(`binary STL is shorter than its header (84 bytes): ${file}`)
    const count = buffer.readUInt32LE(80)
    if (!count) throw new Error(`binary STL declares 0 triangles: ${file}`)
    const expected = 84 + 50 * count
    if (buffer.length < expected) throw new Error(`binary STL is truncated: declares ${count} triangles (${expected} bytes), file has ${buffer.length}`)
    for (let i = 0; i < count; i += 1) {
      const base = 84 + i * 50 + 12
      for (let v = 0; v < 3; v += 1) {
        const o = base + v * 12
        out.push(buffer.readFloatLE(o), buffer.readFloatLE(o + 4), buffer.readFloatLE(o + 8))
      }
    }
  }
  if (out.length % 9 !== 0) throw new Error(`STL triangle list is not a multiple of 9 numbers: ${file}`)
  return Float64Array.from(out)
}

/** Area, signed volume and bbox of a triangle soup. */
export function surfaceMetrics(tris) {
  let area = 0
  let volume = 0
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i], ay = tris[i + 1], az = tris[i + 2]
    const bx = tris[i + 3], by = tris[i + 4], bz = tris[i + 5]
    const cx = tris[i + 6], cy = tris[i + 7], cz = tris[i + 8]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    area += Math.hypot(nx, ny, nz) / 2
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6
    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [cx, cy, cz]]) {
      if (x < min[0]) min[0] = x
      if (y < min[1]) min[1] = y
      if (z < min[2]) min[2] = z
      if (x > max[0]) max[0] = x
      if (y > max[1]) max[1] = y
      if (z > max[2]) max[2] = z
    }
  }
  const diag = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) || 1
  return { triangles: tris.length / 9, area, volume: Math.abs(volume), bbox: { min, max }, diag }
}

/** Ericson, Real-Time Collision Detection: closest point on a triangle to p. */
function closestOnTriangle(p, ax, ay, az, bx, by, bz, cx, cy, cz, out) {
  const abx = bx - ax, aby = by - ay, abz = bz - az
  const acx = cx - ax, acy = cy - ay, acz = cz - az
  const apx = p[0] - ax, apy = p[1] - ay, apz = p[2] - az
  const d1 = abx * apx + aby * apy + abz * apz
  const d2 = acx * apx + acy * apy + acz * apz
  if (d1 <= 0 && d2 <= 0) { out[0] = ax; out[1] = ay; out[2] = az; return out }
  const bpx = p[0] - bx, bpy = p[1] - by, bpz = p[2] - bz
  const d3 = abx * bpx + aby * bpy + abz * bpz
  const d4 = acx * bpx + acy * bpy + acz * bpz
  if (d3 >= 0 && d4 <= d3) { out[0] = bx; out[1] = by; out[2] = bz; return out }
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const t = d1 / (d1 - d3)
    out[0] = ax + t * abx; out[1] = ay + t * aby; out[2] = az + t * abz
    return out
  }
  const cpx = p[0] - cx, cpy = p[1] - cy, cpz = p[2] - cz
  const d5 = abx * cpx + aby * cpy + abz * cpz
  const d6 = acx * cpx + acy * cpy + acz * cpz
  if (d6 >= 0 && d5 <= d6) { out[0] = cx; out[1] = cy; out[2] = cz; return out }
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const t = d2 / (d2 - d6)
    out[0] = ax + t * acx; out[1] = ay + t * acy; out[2] = az + t * acz
    return out
  }
  const wa = d3 * d6 - d5 * d4
  if (wa <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const t = (d4 - d3) / ((d4 - d3) + (d5 - d6))
    out[0] = bx + t * (cx - bx); out[1] = by + t * (cy - by); out[2] = bz + t * (cz - bz)
    return out
  }
  const denom = 1 / (vaWhere(vb, vc, wa) || 1)
  const v = vb * denom
  const w = vc * denom
  out[0] = ax + abx * v + acx * w
  out[1] = ay + aby * v + acy * w
  out[2] = az + abz * v + acz * w
  return out
}

function vaWhere(vb, vc, wa) { return vb + vc + wa }

/** Uniform grid over triangle bounding boxes; queries expand their search radius until a hit is inside it. */
export function buildGrid(tris, cellsPerSide = 24) {
  const metrics = surfaceMetrics(tris)
  const cell = Math.max(metrics.diag / cellsPerSide, 1e-12)
  const lo = [...metrics.bbox.min]
  const key = (i, j, k) => `${i},${j},${k}`
  const grid = new Map()
  for (let t = 0; t < tris.length; t += 9) {
    const x0 = Math.min(tris[t], tris[t + 3], tris[t + 6])
    const x1 = Math.max(tris[t], tris[t + 3], tris[t + 6])
    const y0 = Math.min(tris[t + 1], tris[t + 4], tris[t + 7])
    const y1 = Math.max(tris[t + 1], tris[t + 4], tris[t + 7])
    const z0 = Math.min(tris[t + 2], tris[t + 5], tris[t + 8])
    const z1 = Math.max(tris[t + 2], tris[t + 5], tris[t + 8])
    const i0 = Math.floor((x0 - lo[0]) / cell), i1 = Math.floor((x1 - lo[0]) / cell)
    const j0 = Math.floor((y0 - lo[1]) / cell), j1 = Math.floor((y1 - lo[1]) / cell)
    const k0 = Math.floor((z0 - lo[2]) / cell), k1 = Math.floor((z1 - lo[2]) / cell)
    for (let i = i0; i <= i1; i += 1) {
      for (let j = j0; j <= j1; j += 1) {
        for (let k = k0; k <= k1; k += 1) {
          const kk = key(i, j, k)
          const bucket = grid.get(kk)
          if (bucket) bucket.push(t)
          else grid.set(kk, [t])
        }
      }
    }
  }
  return { grid, cell, lo, diag: metrics.diag, tris }
}

/** Distance from p to the nearest triangle in the grid (exact up to the searched neighbourhood). */
export function distanceToGrid(p, index) {
  const { grid, cell, lo, diag } = index
  const closest = [0, 0, 0]
  const i0 = Math.floor((p[0] - lo[0]) / cell)
  const j0 = Math.floor((p[1] - lo[1]) / cell)
  const k0 = Math.floor((p[2] - lo[2]) / cell)
  let best = Infinity
  const maxRing = Math.ceil(diag / cell) + 1
  for (let ring = 0; ring <= maxRing; ring += 1) {
    for (let i = i0 - ring; i <= i0 + ring; i += 1) {
      for (let j = j0 - ring; j <= j0 + ring; j += 1) {
        for (let k = k0 - ring; k <= k0 + ring; k += 1) {
          if (Math.max(Math.abs(i - i0), Math.abs(j - j0), Math.abs(k - k0)) !== ring) continue
          const bucket = grid.get(`${i},${j},${k}`)
          if (!bucket) continue
          for (const t of bucket) {
            closestOnTriangle(p, index.tris[t], index.tris[t + 1], index.tris[t + 2], index.tris[t + 3], index.tris[t + 4], index.tris[t + 5], index.tris[t + 6], index.tris[t + 7], index.tris[t + 8], closest)
            const d = Math.hypot(p[0] - closest[0], p[1] - closest[1], p[2] - closest[2])
            if (d < best) best = d
          }
        }
      }
    }
    // everything outside the searched cube is at least (ring*cell - |p - cell centre|) away; if the best
    // distance is already below that, no farther triangle can be closer.
    if (best <= ring * cell) return best
  }
  return best
}

/** One-sided approximate Hausdorff: max over sampled centroids of `from` of the distance to `index`. */
export function hausdorffApprox(from, index, samples = 2000) {
  const count = from.length / 9
  const step = Math.max(1, Math.floor(count / samples))
  let worst = 0
  for (let t = 0; t < from.length; t += 9 * step) {
    const c = [
      (from[t] + from[t + 3] + from[t + 6]) / 3,
      (from[t + 1] + from[t + 4] + from[t + 7]) / 3,
      (from[t + 2] + from[t + 5] + from[t + 8]) / 3,
    ]
    const d = distanceToGrid(c, index)
    if (d > worst) worst = d
  }
  return { hausdorff: worst, samples: Math.ceil(count / step) }
}

/** Compare two triangle soups; returns relative differences and the verdict ingredients. */
export function compareSurfaces(referenceTris, meshedTris, { tol = 0.05, samples = 2000 } = {}) {
  const a = surfaceMetrics(referenceTris)
  const b = surfaceMetrics(meshedTris)
  const diag = a.diag || 1
  const bboxRel = Math.max(...[0, 1, 2].map((i) => Math.max(
    Math.abs(a.bbox.max[i] - b.bbox.max[i]),
    Math.abs(a.bbox.min[i] - b.bbox.min[i]),
  ))) / diag
  const areaRel = Math.abs(a.area - b.area) / Math.max(a.area, EPS)
  const volRel = Math.abs(a.volume - b.volume) / Math.max(a.volume, EPS)
  const indexB = buildGrid(meshedTris)
  const indexA = buildGrid(referenceTris)
  const forward = hausdorffApprox(referenceTris, indexB, samples)
  const backward = hausdorffApprox(meshedTris, indexA, samples)
  const hausdorff = Math.max(forward.hausdorff, backward.hausdorff)
  const hausdorffRel = hausdorff / diag
  // Area is a diagnostic, not a criterion: a snapped (voxel) snappy surface is stair-stepped and
  // legitimately carries more area than the smooth STL, while bbox and Hausdorff stay faithful.
  const areasDiffer = areaRel > tol * 2
  const pass = bboxRel <= tol && hausdorffRel <= tol
  return {
    pass,
    tol,
    reference: { triangles: a.triangles, area_m2: a.area, volume_m3: a.volume, bbox_m: a.bbox },
    mesh: { triangles: b.triangles, area_m2: b.area, volume_m3: b.volume, bbox_m: b.bbox },
    diffs: { bboxRel, areaRel, volRel, hausdorffRel },
    hausdorff_m: hausdorff,
    samples: { forward: forward.samples, backward: backward.samples },
    areasDiffer,
    note: 'hausdorff is approximate: max distance from triangle centroids of one surface to the triangles of the other;'
      + (areasDiffer ? ' areas differ — expected for a stair-stepped voxel surface, which is why area is a diagnostic only' : ''),
  }
}

// --- polyMesh readers: the patch surface is exported in JS, because OpenFOAM.com has no
// `surfaceMeshTriangulate` (org-only utility) and the check should not depend on the distribution. ---

/** Strip `//` comment lines and the FoamFile header block from an ASCII OpenFOAM list file. */
function stripComments(text) {
  return text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')
}

function assertAscii(text, file) {
  if (!text.includes('FoamFile') && !text.trimStart().startsWith('(') && !/^\d+\s*\(/m.test(text)) {
    throw new Error(`not an OpenFOAM list file: ${file}`)
  }
  if (/\u0000/.test(text.slice(0, 2000))) throw new Error(`binary polyMesh is not supported (writeFormat ascii): ${file}`)
}

/** Points of constant/<region>/polyMesh/points (or a supplied file) as a flat [x,y,z,…] array. */
export function readPolyMeshPoints(file) {
  const text = stripComments(readFileSync(file, 'utf8'))
  assertAscii(text, file)
  const open = text.indexOf('\n(')
  if (open < 0) throw new Error(`cannot find the points list in ${file}`)
  const close = text.indexOf('\n)', open)
  const body = text.slice(open + 2, close < 0 ? undefined : close)
  const out = []
  for (const match of body.matchAll(/\(\s*([-+0-9.eE]+)\s+([-+0-9.eE]+)\s+([-+0-9.eE]+)\s*\)/g)) {
    out.push(Number(match[1]), Number(match[2]), Number(match[3]))
  }
  if (!out.length) throw new Error(`no points parsed from ${file}`)
  return Float64Array.from(out)
}

/** Faces of a polyMesh faces file: [{size, start}] referencing the points array by index. */
export function readPolyMeshFaces(file) {
  const text = stripComments(readFileSync(file, 'utf8'))
  assertAscii(text, file)
  const match = /\n(\d+)\s*\n?\s*\(/.exec(text)
  if (!match) throw new Error(`cannot find the face list in ${file}`)
  const declared = Number(match[1])
  const body = text.slice(match.index + match[0].length)
  const faces = []
  for (const m of body.matchAll(/(\d+)\(([^)]*)\)/g)) {
    const size = Number(m[1])
    const indices = m[2].trim().split(/\s+/).map(Number)
    if (indices.length !== size) continue
    faces.push({ size, vertex: indices })
  }
  if (declared && faces.length !== declared) {
    throw new Error(`face count mismatch in ${file}: declared ${declared}, parsed ${faces.length}`)
  }
  return faces
}

/** Boundary patches: [{name, type, nFaces, startFace}]. */
export function readPolyMeshBoundary(file) {
  const text = stripComments(readFileSync(file, 'utf8'))
  assertAscii(text, file)
  const patches = []
  for (const m of text.matchAll(/([A-Za-z_][\w.-]*)\s*\{([^}]*)\}/g)) {
    const name = m[1]
    const body = m[2]
    if (!/type\s+\w+;/.test(body)) continue
    if (name === 'FoamFile') continue
    const type = /type\s+(\w+);/.exec(body)?.[1]
    const nFaces = Number(/nFaces\s+(\d+);/.exec(body)?.[1] ?? 0)
    const startFace = Number(/startFace\s+(\d+);/.exec(body)?.[1] ?? -1)
    if (startFace >= 0) patches.push({ name, type, nFaces, startFace })
  }
  if (!patches.length) throw new Error(`no patches parsed from ${file}`)
  return patches
}

/**
 * Triangulated surface of the named patches of a case (fan triangulation, metres).
 * @returns {{triangles: Float64Array, patches: string[], faces: number}}
 */
export function exportPatchTriangles(caseDir, patchNames) {
  const regionDir = join(caseDir, 'constant', 'polyMesh')
  const points = readPolyMeshPoints(join(regionDir, 'points'))
  const faces = readPolyMeshFaces(join(regionDir, 'faces'))
  const boundary = readPolyMeshBoundary(join(regionDir, 'boundary'))
  const wanted = new Set(patchNames)
  const missing = [...wanted].filter((name) => !boundary.some((p) => p.name === name))
  if (missing.length) {
    throw new Error(`patch not found: ${missing.join(', ')}; the case has ${boundary.map((p) => p.name).join(', ')}`)
  }
  const out = []
  let used = 0
  for (const patch of boundary) {
    if (!wanted.has(patch.name)) continue
    for (let f = patch.startFace; f < patch.startFace + patch.nFaces; f += 1) {
      const face = faces[f]
      if (!face) continue
      used += 1
      const v0 = face.vertex[0]
      for (let i = 1; i + 1 < face.size; i += 1) {
        for (const idx of [v0, face.vertex[i], face.vertex[i + 1]]) {
          out.push(points[idx * 3], points[idx * 3 + 1], points[idx * 3 + 2])
        }
      }
    }
  }
  return { triangles: Float64Array.from(out), patches: [...wanted], faces: used }
}

/** Write triangles (Float64Array, 9 doubles per triangle, metres) as an ASCII STL. */
export function writeTrianglesStl(file, triangles) {
  const lines = ['solid surface-check']
  for (let i = 0; i < triangles.length; i += 9) {
    const ax = triangles[i], ay = triangles[i + 1], az = triangles[i + 2]
    const bx = triangles[i + 3], by = triangles[i + 4], bz = triangles[i + 5]
    const cx = triangles[i + 6], cy = triangles[i + 7], cz = triangles[i + 8]
    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const norm = Math.hypot(nx, ny, nz) || 1
    nx /= norm; ny /= norm; nz /= norm
    lines.push(`  facet normal ${nx} ${ny} ${nz}`)
    lines.push('    outer loop')
    lines.push(`      vertex ${ax} ${ay} ${az}`)
    lines.push(`      vertex ${bx} ${by} ${bz}`)
    lines.push(`      vertex ${cx} ${cy} ${cz}`)
    lines.push('    endloop')
    lines.push('  endfacet')
  }
  lines.push('endsolid surface-check', '')
  writeFileSync(file, lines.join('\n'))
  return { file, triangles: triangles.length / 9, bytes: Buffer.byteLength(lines.join('\n')) }
}
