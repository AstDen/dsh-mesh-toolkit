/**
 * mesh-stl/lib/qa/index.js — dependency-free STL quality engine.
 *
 * Drop-in replacement for `tools/qa/stl_qa.py`: same report field names, same
 * verdict strings, same cleanup output, so the plugin no longer needs a python
 * interpreter and the project tree to check geometry.
 * @module mesh-stl/lib/qa
 */
import { readStl, mergeVertices } from './reader.js'
import { analyze } from './metrics.js'
import { dropDegenerateFaces, dropUnreferencedVertices, fileSize, writeBinaryStl } from './clean.js'
import { judge } from './verdict.js'

const round = (value) => (Number.isFinite(value) ? value : null)

/** Clean surface: drop degenerate faces, drop unreferenced vertices, re-merge. */
function cleanedMesh(positions, faces, mergeOptions) {
  const kept = dropDegenerateFaces(positions, faces)
  const reduced = dropUnreferencedVertices(positions, kept)
  const merged = mergeVertices(reduced.positions, reduced.faces, mergeOptions)
  return { ...merged, trianglesBefore: faces.length / 3 }
}

/** ASCII STLs merge on position + facet normal (trimesh), binary ones on position only. */
const mergeOptionsFor = (stl) => (stl.format === 'ascii' ? { normals: stl.normals } : {})

/**
 * Analyse an STL and return the python QA report shape.
 * @param {string} file
 * @param {{cleanOut?: string, expectVolume?: number, expectArea?: number,
 *   expectBodies?: number, maxVolumeErr?: number, maxAreaErr?: number}} options
 */
export function qaStl(file, options = {}) {
  const stl = readStl(file)
  const mergeOptions = mergeOptionsFor(stl)
  const merged = mergeVertices(stl.positions, stl.faces, mergeOptions)
  const raw = analyze(merged.vertices, merged.faces)
  const clean = cleanedMesh(merged.vertices, merged.faces, mergeOptions)
  const cleaned = analyze(clean.vertices, clean.faces)

  const warnings = []
  if (raw.duplicateFaceGroups > 0) warnings.push(`duplicate faces: ${raw.duplicateFaceGroups} групп`)
  if (raw.nonManifoldEdges > 0) {
    warnings.push(`non-manifold: ${raw.nonManifoldEdges} рёбер с >2 гранями (касание поверхностей нулевой толщины: `
      + 'snappy это мешит, но оболочка не является замкнутой; держите зазор >= 2*MeshSizeMin, D-007)')
  }
  if (raw.degenerateFaces > 0) {
    warnings.push(`degenerate faces: ${raw.degenerateFaces} (объём не искажают, но ломают is_watertight)`)
  }
  if (cleaned.bodies !== null && options.expectBodies != null && cleaned.bodies !== Number(options.expectBodies)) {
    warnings.push(`тел ${cleaned.bodies}, ожидалось ${options.expectBodies} (1 + число замкнутых полостей)`)
  }
  if (raw.degenerateFaces > 0) {
    const flag = raw.isWatertight ? 'True' : 'False'
    warnings.push(`сырой STL: ${raw.degenerateFaces} вырожденных граней, is_watertight=${flag} -> `
      + 'нужен шаг чистки (--clean-out)')
  }

  const report = {
    path: file,
    file_size_bytes: readStlSize(file, stl.bytes),
    stl_format: stl.format,
    triangles: raw.triangles,
    vertices_raw: stl.positions.length / 3,
    vertices_merged: raw.verticesMerged,
    is_watertight: raw.isWatertight,
    is_winding_consistent: raw.isWindingConsistent,
    euler_number: raw.eulerNumber,
    bodies: raw.bodies,
    volume: round(raw.volume),
    area: round(raw.area),
    bbox_min: raw.bboxMin,
    bbox_max: raw.bboxMax,
    bbox_size: raw.bboxSize,
    degenerate_faces: raw.degenerateFaces,
    duplicate_face_groups: raw.duplicateFaceGroups,
    non_manifold_edges: raw.nonManifoldEdges,
    expected_bodies: options.expectBodies ?? null,
    warnings,
    cleaned: {
      triangles: cleaned.triangles,
      is_watertight: cleaned.isWatertight,
      is_winding_consistent: cleaned.isWindingConsistent,
      euler_number: cleaned.eulerNumber,
      bodies: cleaned.bodies,
      volume: round(cleaned.volume),
      area: round(cleaned.area),
    },
  }

  if (options.cleanOut) {
    report.clean = cleanStl(file, options.cleanOut, { merged, mergeOptions })
  }

  const verdict = judge(report, options)
  report.problems = verdict.problems
  report.verdict = verdict.verdict
  return report
}

function readStlSize(file, fallback) {
  return fileSize(file) ?? fallback
}

/**
 * Write a cleaned binary STL (degenerate faces dropped, vertices merged).
 * @param {string} file source STL
 * @param {string} outPath target STL
 */
export function cleanStl(file, outPath, { merged = null, mergeOptions = null } = {}) {
  const source = merged ?? (() => {
    const stl = readStl(file)
    return mergeVertices(stl.positions, stl.faces, mergeOptionsFor(stl))
  })()
  const clean = cleanedMesh(source.vertices, source.faces, mergeOptions ?? {})
  const written = writeBinaryStl(outPath, clean.vertices, clean.faces)
  const check = analyze(clean.vertices, clean.faces)
  return {
    source: file,
    output: outPath,
    triangles_before: source.faces.length / 3,
    triangles_after: written.triangles,
    removed: source.faces.length / 3 - written.triangles,
    file_size_bytes: written.bytes,
    is_watertight: check.isWatertight,
    bodies: check.bodies,
  }
}
