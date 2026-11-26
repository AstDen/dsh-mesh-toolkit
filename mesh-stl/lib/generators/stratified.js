/**
 * mesh-stl/lib/generators/stratified.js — two-fluid stratified channel, pure JS.
 *
 * A rectangular channel cut by the horizontal plane z = interface_z: `lower.stl`
 * covers 0..interface_z, `upper.stl` covers interface_z..Lz. Twelve triangles each,
 * millimetres, closed shells with outward normals. No Python, no project data.
 * @module mesh-stl/lib/generators/stratified
 */
import { writeFileSync } from 'node:fs'
import { boxTriangles, writeBinaryStl } from '../shapes.js'

function positive(value, label) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number, got ${value}`)
  return parsed
}

/**
 * Write the two parts of a stratified channel.
 * @param {{domain_mm?: number[], interface_z_mm?: number}} params
 * @param {{outDir: string, name: string, json: string}} ctx
 */
export function run(params, ctx) {
  const domain = Array.isArray(params.domain_mm) && params.domain_mm.length === 3
    ? params.domain_mm.map(Number)
    : null
  if (!domain) throw new Error('domain_mm must be [lx, ly, lz] in millimetres')
  const [lx, ly, lz] = domain.map((value, index) => positive(value, `domain_mm[${index}]`))
  const interfaceZ = params.interface_z_mm === undefined ? lz / 2 : Number(params.interface_z_mm)
  if (!Number.isFinite(interfaceZ) || interfaceZ <= 0 || interfaceZ >= lz) {
    throw new Error(`interface_z_mm must be between 0 and ${lz} (exclusive), got ${params.interface_z_mm}`)
  }
  const parts = [
    { role: 'fluid', name: 'lower', file: `${ctx.outDir}/${ctx.name}.lower.stl`, size: [lx, ly, interfaceZ], center: [lx / 2, ly / 2, interfaceZ / 2] },
    { role: 'fluid', name: 'upper', file: `${ctx.outDir}/${ctx.name}.upper.stl`, size: [lx, ly, lz - interfaceZ], center: [lx / 2, ly / 2, interfaceZ + (lz - interfaceZ) / 2] },
  ]
  const written = parts.map((part) => {
    // boxTriangles already winds outward for a convex body; the centre is the box centre.
    const info = writeBinaryStl(part.file, boxTriangles(part.size, part.center))
    return {
      role: part.role,
      part: part.name,
      file: part.file,
      triangles: info.triangles,
      bytes: info.bytes,
      size_mm: part.size,
      center_mm: part.center,
      volume_mm3_theory: part.size[0] * part.size[1] * part.size[2],
    }
  })
  const info = {
    family: 'stratified-channel',
    units: 'mm',
    domain_mm: [lx, ly, lz],
    interface_z_mm: interfaceZ,
    parts: written,
    volume_mm3_total: lx * ly * lz,
    generated_by: 'mesh-stl/lib/generators/stratified.js',
  }
  writeFileSync(ctx.json, `${JSON.stringify(info, null, 2)}\n`, 'utf8')
  return info
}
