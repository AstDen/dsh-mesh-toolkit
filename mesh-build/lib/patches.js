/**
 * mesh-build/lib/patches.js — read the patch list back from a built mesh.
 *
 * A mesh is not ready for a solver just because checkMesh passes: the patches
 * must be distinguishable (inlet/outlet/wall/sphere walls). This module only
 * reads constant/<region>/polyMesh/boundary and summarises it — it never edits.
 * @module mesh-build/lib/patches
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { detectRegions } from './gate.js'

/** Patch types a solver can use as an inlet/outlet. */
const FLOW_TYPES = new Set(['patch', 'cyclic', 'cyclicAMI', 'wedge', 'empty'])

/**
 * Parse one polyMesh/boundary file.
 * @param {string} file
 * @returns {{patches: Array<{name: string, type: string, nFaces: number}>, nFaces: number}}
 */
export function parseBoundaryFile(file) {
  const text = readFileSync(file, 'utf8')
  const patches = []
  // each patch is `name { type X; nFaces N; ... }`; the FoamFile header has no nFaces, so it is skipped
  const block = /(^|\n)\s*([A-Za-z_][\w.\-]*)\s*\n?\s*\{([^{}]*)\}/g
  let m
  while ((m = block.exec(text)) !== null) {
    const [, , name, body] = m
    const faces = body.match(/nFaces\s+(\d+)\s*;/)
    if (!faces) continue
    const type = body.match(/type\s+([\w]+)\s*;/)
    patches.push({ name, type: type ? type[1] : 'unknown', nFaces: Number(faces[1]) })
  }
  const nFaces = patches.reduce((sum, p) => sum + p.nFaces, 0)
  return { patches, nFaces }
}

/**
 * Patch summary for a case: one entry per region (or the base mesh).
 * `openPatches` lists patches whose type can serve as a flow boundary,
 * `wallFaces` counts faces locked on walls.
 * @param {string} caseDir
 */
export function readCasePatches(caseDir) {
  const constant = join(caseDir, 'constant')
  const regions = detectRegions(caseDir)
  const targets = regions.length
    ? regions.map((region) => ({ region, file: join(constant, region, 'polyMesh', 'boundary') }))
    : [{ region: null, file: join(constant, 'polyMesh', 'boundary') }]
  const out = []
  for (const target of targets) {
    if (!existsSync(target.file)) continue
    const { patches, nFaces } = parseBoundaryFile(target.file)
    const flowPatches = patches.filter((p) => FLOW_TYPES.has(p.type)).map((p) => p.name)
    const symmetryPatches = patches.filter((p) => String(p.type).startsWith('symmetry')).map((p) => p.name)
    out.push({
      region: target.region,
      file: target.file,
      nPatches: patches.length,
      nFaces,
      patches,
      flowPatches,
      symmetryPatches,
      wallFaces: patches.filter((p) => p.type === 'wall').reduce((s, p) => s + p.nFaces, 0),
    })
  }
  const types = new Set(out.flatMap((entry) => entry.patches.map((p) => p.type)))
  const flow = out.flatMap((entry) => entry.flowPatches)
  const symmetry = out.flatMap((entry) => entry.symmetryPatches)
  const notes = []
  if (out.length && types.size <= 1) {
    notes.push(`every patch has type "${[...types][0] ?? 'none'}": outer domain faces and internal surfaces are indistinguishable — rename them (inlet/outlet/wall) before building a case`)
  }
  if (symmetry.length) {
    notes.push(`symmetry patches (${symmetry.join(', ')}) are mesh-safe but not flow boundaries: retype them to patch/wall after meshing (recipe in hint snappy-symmetry-domain / exp-006)`)
  }
  if (!flow.length) {
    notes.push('no inlet/outlet (no patch of type patch/cyclic) — the case is walls only until the boundaries are retyped')
  }
  return {
    multiRegion: regions.length > 1,
    types: [...types],
    notes,
    entries: out.map((entry) => ({
      region: entry.region,
      nPatches: entry.nPatches,
      nFaces: entry.nFaces,
      flowPatches: entry.flowPatches,
      symmetryPatches: entry.symmetryPatches,
      wallFaces: entry.wallFaces,
      patches: entry.patches,
    })),
  }
}
