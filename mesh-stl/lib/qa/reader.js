/**
 * mesh-stl/lib/qa/reader.js — STL parsing and vertex merge, no dependencies.
 *
 * Both formats are supported: binary (the usual export) and ASCII (primitives,
 * hand-written patches). The merge rule reproduces trimesh 5.x, which the python
 * QA used: binary STLs merge by rounded position (8 decimals), ASCII STLs merge
 * by position AND the facet normal written in the file (2 decimals) — that is
 * why a triplicated patch keeps three times the vertices. Faces with repeated
 * indices are KEPT here (the python QA counts them as degenerate, not dropped).
 * @module mesh-stl/lib/qa/reader
 */
import { readFileSync } from 'node:fs'

const isAscii = (buffer) => {
  const head = buffer.subarray(0, 5).toString('latin1').toLowerCase()
  if (head !== 'solid') return false
  // "solid" may also start a binary file that happens to begin with those bytes:
  // require a `facet` keyword within the first 512 bytes.
  return buffer.subarray(0, 512).toString('latin1').toLowerCase().includes('facet')
}

/** Parse a binary STL into flat vertex triplets, triangle indices and facet normals. */
function parseBinary(buffer) {
  if (buffer.length < 84) throw new Error('binary STL is shorter than its header (84 bytes)')
  const count = buffer.readUInt32LE(80)
  const expected = 84 + count * 50
  if (count === 0) throw new Error('binary STL declares 0 triangles')
  if (buffer.length < expected) {
    throw new Error(`binary STL is truncated: declares ${count} triangles (${expected} bytes), file has ${buffer.length}`)
  }
  const positions = new Float64Array(count * 9)
  const normals = new Float64Array(count * 3)
  const faces = new Int32Array(count * 3)
  for (let i = 0; i < count; i += 1) {
    const record = 84 + i * 50
    for (let k = 0; k < 3; k += 1) normals[i * 3 + k] = buffer.readFloatLE(record + k * 4)
    const base = record + 12 // skip the normal
    for (let k = 0; k < 9; k += 1) positions[i * 9 + k] = buffer.readFloatLE(base + k * 4)
    faces[i * 3] = i * 3
    faces[i * 3 + 1] = i * 3 + 1
    faces[i * 3 + 2] = i * 3 + 2
  }
  return { positions, faces, normals, format: 'binary' }
}

/** Parse an ASCII STL (`facet normal` + three `vertex` lines per facet). */
function parseAscii(text) {
  const positions = []
  const normals = []
  const faces = []
  let normal = [0, 0, 0]
  let corners = []
  const number = '([-+0-9.eE]+)'
  const normalRe = new RegExp(`facet\\s+normal\\s+${number}\\s+${number}\\s+${number}`, 'i')
  const vertexRe = new RegExp(`^\\s*vertex\\s+${number}\\s+${number}\\s+${number}`, 'i')
  for (const line of text.split(/\r?\n/)) {
    const facet = normalRe.exec(line)
    if (facet) {
      normal = [Number(facet[1]), Number(facet[2]), Number(facet[3])]
      corners = []
      continue
    }
    const vertex = vertexRe.exec(line)
    if (!vertex) continue
    corners.push(Number(vertex[1]), Number(vertex[2]), Number(vertex[3]))
    if (corners.length === 9) {
      const base = positions.length / 3
      positions.push(...corners)
      normals.push(...normal)
      faces.push(base, base + 1, base + 2)
      corners = []
    }
  }
  if (positions.length === 0) throw new Error('ASCII STL has no "vertex" lines')
  if (positions.length % 9 !== 0) throw new Error(`ASCII STL vertex count ${positions.length / 3} is not a multiple of 9`)
  return {
    positions: Float64Array.from(positions),
    faces: Int32Array.from(faces),
    normals: Float64Array.from(normals),
    format: 'ascii',
  }
}

/** Read an STL file: `{ positions, faces, normals, format, triangles, bytes }`. */
export function readStl(file) {
  const buffer = readFileSync(file)
  const parsed = isAscii(buffer) ? parseAscii(buffer.toString('utf8')) : parseBinary(buffer)
  const triangles = parsed.faces.length / 3
  if (triangles === 0) throw new Error(`${file}: no triangles`)
  return { ...parsed, triangles, bytes: buffer.length }
}

const roundTo = (value, scale) => {
  const rounded = Math.round(value * scale) / scale
  return Object.is(rounded, -0) ? 0 : rounded
}

/**
 * Merge coincident vertices, mirroring trimesh 5.x:
 * binary → rounded position only; ASCII → rounded position + rounded facet normal.
 * Degenerate triangles are kept (the caller reports them), so `triangles` never changes.
 */
export function mergeVertices(positions, faces, { normals = null, digits = 8, normalDigits = 2 } = {}) {
  const scale = 10 ** digits
  const normalScale = 10 ** normalDigits
  const useNormals = Boolean(normals)
  const map = new Map()
  const vertices = []
  const remap = new Int32Array(positions.length / 3)
  for (let i = 0; i < remap.length; i += 1) {
    const x = roundTo(positions[i * 3], scale)
    const y = roundTo(positions[i * 3 + 1], scale)
    const z = roundTo(positions[i * 3 + 2], scale)
    let key = `${x},${y},${z}`
    if (useNormals) {
      const f = Math.floor(i / 3)
      key += `|${roundTo(normals[f * 3], normalScale)},${roundTo(normals[f * 3 + 1], normalScale)},${roundTo(normals[f * 3 + 2], normalScale)}`
    }
    let index = map.get(key)
    if (index === undefined) {
      index = vertices.length / 3
      vertices.push(x, y, z)
      map.set(key, index)
    }
    remap[i] = index
  }
  const out = new Int32Array(faces.length)
  for (let i = 0; i < faces.length; i += 1) out[i] = remap[faces[i]]
  return { vertices: Float64Array.from(vertices), faces: out, verticesRaw: remap.length }
}
