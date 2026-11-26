/**
 * mesh-stl/lib/qa/clean.js — drop degenerate faces and write a binary STL.
 * @module mesh-stl/lib/qa/clean
 */
import { statSync, writeFileSync } from 'node:fs'

const sub = (v, i) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

/**
 * Keep faces whose oriented bounding box is thicker than `tol` on both sides —
 * trimesh's `nondegenerate_faces(height=tol.merge)`, i.e. every edge AND every
 * triangle height above 1e-8 mm. An area-only gate is wrong: a 1 µm sliver with
 * area 1e-13 is legitimate geometry, and dropping it opens the surface.
 */
export function dropDegenerateFaces(positions, faces, tol = 1e-8) {
  const kept = []
  const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
  for (let f = 0; f < faces.length; f += 3) {
    const pa = sub(positions, faces[f])
    const pb = sub(positions, faces[f + 1])
    const pc = sub(positions, faces[f + 2])
    const edges = [dist(pa, pb), dist(pb, pc), dist(pc, pa)]
    const shortestEdge = Math.min(...edges)
    const n = cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]])
    const area = Math.hypot(n[0], n[1], n[2]) / 2
    const shortestHeight = Math.max(...edges) > 0 ? (2 * area) / Math.max(...edges) : 0
    if (shortestEdge > tol && shortestHeight > tol) kept.push(faces[f], faces[f + 1], faces[f + 2])
  }
  return Int32Array.from(kept)
}

/** Drop vertices no face references (trimesh `update_faces(remove_unreferenced=True)`). */
export function dropUnreferencedVertices(positions, faces) {
  const nv = positions.length / 3
  const map = new Int32Array(nv).fill(-1)
  const out = []
  const remapped = new Int32Array(faces.length)
  for (let i = 0; i < faces.length; i += 1) {
    const v = faces[i]
    if (map[v] === -1) {
      map[v] = out.length / 3
      out.push(positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2])
    }
    remapped[i] = map[v]
  }
  return { positions: Float64Array.from(out), faces: remapped }
}

/** Serialize a triangle soup as a binary STL with per-face normals. */
export function writeBinaryStl(file, positions, faces) {
  const triangles = faces.length / 3
  const buffer = Buffer.alloc(84 + triangles * 50)
  buffer.write('mesh-stl qa cleanup', 0, 'latin1')
  buffer.writeUInt32LE(triangles, 80)
  for (let f = 0; f < faces.length; f += 3) {
    const pa = sub(positions, faces[f])
    const pb = sub(positions, faces[f + 1])
    const pc = sub(positions, faces[f + 2])
    const n = cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]])
    const len = Math.hypot(n[0], n[1], n[2]) || 1
    const base = 84 + (f / 3) * 50
    const values = [n[0] / len, n[1] / len, n[2] / len, ...pa, ...pb, ...pc]
    for (let k = 0; k < 12; k += 1) buffer.writeFloatLE(values[k], base + k * 4)
    buffer.writeUInt16LE(0, base + 48)
  }
  writeFileSync(file, buffer)
  return { bytes: buffer.length, triangles }
}

export const fileSize = (file) => {
  try {
    return statSync(file).size
  } catch {
    return null
  }
}
