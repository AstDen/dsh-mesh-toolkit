/**
 * mesh-stl/lib/generators/box-array.js — lattice of spheres or cylinders, pure JS.
 *
 * A regular `nx × ny × nz` lattice of convex bodies inside a box container. Writes
 * `<name>.solid.stl` (N closed shells, one file) and `<name>.container.stl` (the box),
 * plus a JSON summary with positions and analytic volumes. Millimetres, outward
 * normals, no Python.
 * @module mesh-stl/lib/generators/box-array
 */
import { writeFileSync } from 'node:fs'
import { boxTriangles, cylinderTriangles, orientOutward, sphereTriangles, writeBinaryStl } from '../shapes.js'

function positive(value, label) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number, got ${value}`)
  return parsed
}

function triple(value, fallback, label) {
  const source = Array.isArray(value) && value.length === 3 ? value : fallback
  return source.map((item, index) => positive(item, `${label}[${index}]`))
}

/**
 * Build the lattice.
 * @param {{container_mm?: number[], lattice?: number[], shape?: string, radius_mm?: number,
 *   height_mm?: number, margin_mm?: number, segments?: number, rings?: number, sections?: number}} params
 * @param {{outDir: string, name: string, json: string}} ctx
 */
export function run(params, ctx) {
  const [lx, ly, lz] = triple(params.container_mm, [10, 10, 20], 'container_mm')
  const [nx, ny, nz] = triple(params.lattice, [2, 2, 4], 'lattice').map((value) => Math.max(1, Math.round(value)))
  const shape = String(params.shape ?? 'sphere').toLowerCase()
  if (!['sphere', 'cylinder'].includes(shape)) throw new Error(`shape must be sphere or cylinder, got ${shape}`)
  const radius = positive(params.radius_mm ?? 1, 'radius_mm')
  const height = shape === 'cylinder' ? positive(params.height_mm ?? 2, 'height_mm') : 0
  const margin = Number(params.margin_mm ?? 0)
  if (!Number.isFinite(margin) || margin < 0) throw new Error('margin_mm must be a non-negative number')

  const spacing = [lx / nx, ly / ny, lz / nz]
  const warnings = []
  const bodySize = [2 * radius, 2 * radius, shape === 'cylinder' ? height : 2 * radius]
  for (let axis = 0; axis < 3; axis += 1) {
    const needed = bodySize[axis] + 2 * margin
    if (spacing[axis] + 1e-9 < needed) {
      warnings.push(`lattice spacing ${spacing[axis].toFixed(4)} mm < body ${needed.toFixed(4)} mm on axis ${'xyz'[axis]}: neighbours intersect (snappy reads intersecting shells as one solid body)`)
    }
  }
  if (shape === 'cylinder' && height > lz) warnings.push(`cylinder height ${height} mm exceeds container height ${lz} mm`)

  const centerLocal = (i, n, length) => ((i + 0.5) * length) / n
  const segments = Math.max(6, Math.round(Number(params.segments ?? 24)))
  const rings = Math.max(3, Math.round(Number(params.rings ?? 12)))
  const sections = Math.max(6, Math.round(Number(params.sections ?? 32)))

  const triangles = []
  const bodies = []
  for (let i = 0; i < nx; i += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let k = 0; k < nz; k += 1) {
        const center = [centerLocal(i, nx, lx), centerLocal(j, ny, ly), centerLocal(k, nz, lz)]
        const local = shape === 'sphere'
          ? sphereTriangles(radius, segments, rings, center)
          : cylinderTriangles(radius, height, sections, center)
        triangles.push(...orientOutward(local, center))
        bodies.push({ index: bodies.length + 1, shape, center_mm: center })
      }
    }
  }
  const solidFile = `${ctx.outDir}/${ctx.name}.solid.stl`
  const containerFile = `${ctx.outDir}/${ctx.name}.container.stl`
  const solid = writeBinaryStl(solidFile, triangles)
  const container = writeBinaryStl(containerFile, boxTriangles([lx, ly, lz], [lx / 2, ly / 2, lz / 2]))
  const volumeOne = shape === 'sphere' ? (4 / 3) * Math.PI * radius ** 3 : Math.PI * radius ** 2 * height
  const info = {
    family: 'box-array',
    units: 'mm',
    shape,
    lattice: [nx, ny, nz],
    spacing_mm: spacing,
    container_mm: [lx, ly, lz],
    bodies: bodies.length,
    radius_mm: radius,
    height_mm: shape === 'cylinder' ? height : null,
    volume_mm3_one: volumeOne,
    volume_mm3_total: volumeOne * bodies.length,
    solid: { file: solidFile, triangles: solid.triangles, bytes: solid.bytes },
    container: { file: containerFile, triangles: container.triangles, bytes: container.bytes },
    warnings,
    generated_by: 'mesh-stl/lib/generators/box-array.js',
  }
  writeFileSync(ctx.json, `${JSON.stringify({ ...info, bodies_detail: bodies }, null, 2)}\n`, 'utf8')
  return info
}
