import { writeFileSync } from 'node:fs'

/** ASCII box from `min` to `max` in metres: 12 triangles with outward winding. */
export function boxTriangles(min, max) {
  const [x0, y0, z0] = min
  const [x1, y1, z1] = max
  const v = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  const faces = [
    [0, 3, 2], [0, 2, 1], // -z
    [4, 5, 6], [4, 6, 7], // +z
    [0, 1, 5], [0, 5, 4], // -y
    [3, 7, 6], [3, 6, 2], // +y
    [0, 4, 7], [0, 7, 3], // -x
    [1, 2, 6], [1, 6, 5], // +x
  ]
  // surfacecheck works on flat vertex arrays: nine numbers per triangle
  return faces.flatMap(([a, b, c]) => [...v[a], ...v[b], ...v[c]])
}

/** Write `triangles` as an ASCII STL; returns the path. */
export function writeAsciiStl(file, triangles, name = 'fixture') {
  const lines = [`solid ${name}`]
  for (let i = 0; i < triangles.length; i += 9) {
    const a = triangles.slice(i, i + 3)
    const b = triangles.slice(i + 3, i + 6)
    const c = triangles.slice(i + 6, i + 9)
    const u = b.map((value, k) => value - a[k])
    const w = c.map((value, k) => value - a[k])
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    const len = Math.hypot(...n) || 1
    lines.push(`  facet normal ${n.map((value) => value / len).join(' ')}`)
    lines.push('    outer loop')
    for (const point of [a, b, c]) lines.push(`      vertex ${point.join(' ')}`)
    lines.push('    endloop')
    lines.push('  endfacet')
  }
  lines.push(`endsolid ${name}`)
  writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

/** Write `triangles` as a binary STL; returns the path. */
export function writeBinaryStl(file, triangles, name = 'fixture') {
  const count = triangles.length / 9
  const buffer = Buffer.alloc(84 + 50 * count)
  buffer.write(name, 0, 'ascii')
  buffer.writeUInt32LE(count, 80)
  for (let index = 0; index < count; index += 1) {
    let offset = 84 + 50 * index + 12 // skip the facet normal, as a real binary STL does
    for (let value = 0; value < 9; value += 1) {
      buffer.writeFloatLE(triangles[index * 9 + value], offset)
      offset += 4
    }
    buffer.writeUInt16LE(0, offset)
  }
  writeFileSync(file, buffer)
  return file
}

/** A handoff document with a domain, a background cell and one refinement zone. */
export function handoffFixture(overrides = {}) {
  return {
    schemaVersion: 'mesh-handoff/1',
    mesh: {
      route: 'snappy',
      cells: 40960,
      selection: { cells: [40, 32, 32], cellSize_m: 0.001, levels: { cav: [1, 2] }, defaultLevel: 1 },
      layers: { nLayers: 3, expansionRatio: 1.5 },
    },
    geometry: { stl: 'cav.stl', bbox_m: { min: [-0.005, -0.005, -0.005], max: [0.005, 0.005, 0.005] } },
    domain: { bbox_m: { min: [-0.035, -0.035, -0.035], max: [0.055, 0.035, 0.035] } },
    history: [],
    ...overrides,
  }
}

/** Feedback document; `category` and `evidence` are the interesting parts. */
export function feedbackFixture(category, extra = {}) {
  return { schemaVersion: 'mesh-feedback/1', category, severity: 'major', ...extra }
}
