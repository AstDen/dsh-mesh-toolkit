/**
 * mesh-stl/lib/qa/metrics.js — surface metrics with no dependencies.
 *
 * Everything the python QA reported, computed with two open-addressing edge
 * tables in typed arrays, so a 1.6 M-triangle STL stays inside a few hundred MB
 * instead of a Map with millions of entries. Body counting mirrors trimesh:
 * faces become connected only through an edge shared by EXACTLY two faces, and
 * a face that shares no such edge is its own body (that is why a triplicated
 * patch reports one body per facet).
 * @module mesh-stl/lib/qa/metrics
 */

const hash64 = (key) => {
  let x = key % 4294967296
  let y = Math.floor(key / 4294967296)
  x = (x ^ (y + 0x9e3779b9 + (x << 6) + (x >>> 2))) >>> 0
  return x
}

/** Open-addressing table: float64 keys → face count, first face id, orientation balance. */
class EdgeTable {
  constructor(capacity) {
    let cap = 16
    while (cap < capacity * 2) cap *= 2
    this.cap = cap
    this.mask = cap - 1
    this.keys = new Float64Array(cap).fill(-1)
    this.count = new Int32Array(cap)
    this.first = new Int32Array(cap).fill(-1)
    this.size = 0
  }

  add(key, faceId) {
    let slot = hash64(key) & this.mask
    while (this.keys[slot] !== -1 && this.keys[slot] !== key) slot = (slot + 1) & this.mask
    if (this.keys[slot] === -1) {
      this.keys[slot] = key
      this.first[slot] = faceId
      this.size += 1
    }
    this.count[slot] += 1
    return slot
  }

  find(key) {
    let slot = hash64(key) & this.mask
    while (this.keys[slot] !== -1) {
      if (this.keys[slot] === key) return slot
      slot = (slot + 1) & this.mask
    }
    return -1
  }
}

/** Union-find over integer ids (path halving, union by size). */
class UnionFind {
  constructor(n) {
    this.parent = new Int32Array(n)
    this.size = new Int32Array(n)
    for (let i = 0; i < n; i += 1) {
      this.parent[i] = i
      this.size[i] = 1
    }
  }

  find(a) {
    let root = a
    while (this.parent[root] !== root) root = this.parent[root]
    let node = a
    while (this.parent[node] !== node) {
      const next = this.parent[node]
      this.parent[node] = root
      node = next
    }
    return root
  }

  union(a, b) {
    let ra = this.find(a)
    let rb = this.find(b)
    if (ra === rb) return
    if (this.size[ra] < this.size[rb]) [ra, rb] = [rb, ra]
    this.parent[rb] = ra
    this.size[ra] += this.size[rb]
  }
}

const sub = (v, i) => [v[i * 3], v[i * 3 + 1], v[i * 3 + 2]]
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]

/**
 * Full surface analysis of a merged triangle soup.
 * @param {Float64Array} positions flat xyz triplets
 * @param {Int32Array} faces three vertex ids per triangle
 */
export function analyze(positions, faces) {
  const triangles = faces.length / 3
  const verticesMerged = positions.length / 3
  const nv = Math.max(1, verticesMerged)
  const pairs = new EdgeTable(Math.max(1, triangles * 3))
  const directed = new EdgeTable(Math.max(1, triangles * 3))
  const faceUf = new UnionFind(Math.max(1, triangles))
  const tripleSeen = new Map()

  let volume = 0
  let area = 0
  let degenerate = 0
  let duplicateGroups = 0
  const bboxMin = [Infinity, Infinity, Infinity]
  const bboxMax = [-Infinity, -Infinity, -Infinity]

  for (let i = 0; i < positions.length; i += 3) {
    for (let k = 0; k < 3; k += 1) {
      const value = positions[i + k]
      if (value < bboxMin[k]) bboxMin[k] = value
      if (value > bboxMax[k]) bboxMax[k] = value
    }
  }

  const faceCount = triangles
  for (let f = 0; f < faceCount; f += 1) {
    const a = faces[f * 3]
    const b = faces[f * 3 + 1]
    const c = faces[f * 3 + 2]
    const pa = sub(positions, a)
    const pb = sub(positions, b)
    const pc = sub(positions, c)
    const n = cross([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]])
    const faceArea = Math.hypot(n[0], n[1], n[2]) / 2
    area += faceArea
    if (faceArea <= 1e-12) degenerate += 1
    volume += (pa[0] * n[0] + pa[1] * n[1] + pa[2] * n[2]) / 6

    const corners = [[a, b], [b, c], [c, a]]
    for (const [u, v] of corners) {
      const lo = u < v ? u : v
      const hi = u < v ? v : u
      pairs.add(lo * nv + hi, f)
      directed.add(u * nv + v, f)
    }

    const sorted = [a, b, c].sort((x, y) => x - y)
    const key = `${sorted[0]},${sorted[1]},${sorted[2]}`
    const seen = tripleSeen.get(key) ?? 0
    if (seen === 1) duplicateGroups += 1
    tripleSeen.set(key, seen + 1)
  }

  // watertight: every undirected edge is shared by exactly two faces
  let watertight = true
  let nonManifold = 0
  for (let slot = 0; slot < pairs.cap; slot += 1) {
    if (pairs.keys[slot] === -1) continue
    const count = pairs.count[slot]
    if (count !== 2) watertight = false
    if (count > 2) nonManifold += 1
  }

  // bodies: face adjacency only across edges shared by exactly two faces
  for (let f = 0; f < faceCount; f += 1) {
    const a = faces[f * 3]
    const b = faces[f * 3 + 1]
    const c = faces[f * 3 + 2]
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const lo = u < v ? u : v
      const hi = u < v ? v : u
      const slot = pairs.find(lo * nv + hi)
      if (pairs.count[slot] === 2 && pairs.first[slot] !== f) faceUf.union(f, pairs.first[slot])
    }
  }
  const roots = new Set()
  for (let f = 0; f < faceCount; f += 1) roots.add(faceUf.find(f))

  // winding: for every edge shared by EXACTLY two faces those faces must traverse it
  // in opposite directions (trimesh semantics: duplicated/non-manifold edges are ignored)
  let windingConsistent = true
  for (let f = 0; f < faceCount && windingConsistent; f += 1) {
    const a = faces[f * 3]
    const b = faces[f * 3 + 1]
    const c = faces[f * 3 + 2]
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const lo = u < v ? u : v
      const hi = u < v ? v : u
      const slot = pairs.find(lo * nv + hi)
      if (pairs.count[slot] !== 2) continue
      const forward = directed.find(u * nv + v)
      const backward = directed.find(v * nv + u)
      if (directed.count[forward] !== 1 || directed.count[backward] !== 1) {
        windingConsistent = false
        break
      }
    }
  }

  const edges = pairs.size
  return {
    triangles,
    verticesMerged,
    isWatertight: watertight,
    isWindingConsistent: windingConsistent,
    eulerNumber: verticesMerged - edges + triangles,
    bodies: roots.size,
    volume,
    area,
    bboxMin,
    bboxMax,
    bboxSize: [bboxMax[0] - bboxMin[0], bboxMax[1] - bboxMin[1], bboxMax[2] - bboxMin[2]],
    degenerateFaces: degenerate,
    duplicateFaceGroups: duplicateGroups,
    nonManifoldEdges: nonManifold,
    edges,
  }
}
