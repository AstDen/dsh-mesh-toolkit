/**
 * blockMesh dictionary: spec <-> text (TW-03).
 *
 * The spec is the explicit, JSON-able form an agent can write without OpenFOAM syntax knowledge, and it
 * covers exactly the subset the shipped tutorials use (checked against all 7 `tutorials/mesh/blockMesh`
 * cases):
 *
 *   {
 *     scale: 1,                          // or convertToMeters
 *     vertices: [[x,y,z], ...],
 *     blocks: [{
 *       hex: [i0..i7],                   // the eight corner indices
 *       cells: [nx,ny,nz],
 *       zone: "block-d",                 // optional cellZone name (blockMesh keeps it)
 *       grading: "simpleGrading (1 1 1)" | "grading (1 1 1)" | {x:[..],y:[..],z:[..]},
 *     }],
 *     edges: [
 *       { type:"arc", points:[i,j], arc:[x,y,z] },            // arc through a point
 *       { type:"arc", points:[i,j], origin:[x,y,z] },         // arc around an origin
 *       { type:"arc", points:[i,j,k], interpolate:[[x,y,z], ...] },
 *       { type:"spline", points:[i,j,...], interpolate:[[x,y,z], ...] },
 *       { type:"project", points:[i,j,k], name:"sphere" },
 *     ],
 *     geometry: { sphere: { type:"sphere", origin:"( 0 0 0 )", radius:"1" } },  // values kept verbatim
 *     faces: [{ project:{ block:0, face:0 }, name:"sphere" }],  // project(...) list
 *     boundary: { patch: { type:"wall", faces: [[v0,v1,v2,v3] | {block:0,face:0}], inGroups?:["a"] } },
 *     mergePatchPairs: [["master", "slave"]],
 *   }
 *
 * Anything outside the subset throws with the offending text instead of being silently dropped.
 * `foamDictionary -expand` must run first for dictionaries that use macros: blockMesh evaluates them
 * itself, this parser does not.
 */
import { readFileSync } from 'node:fs'

export const BLOCKMESH_SCHEMA = 'blockmesh-spec/1'

const num = (value) => {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`blockMesh spec: "${value}" is not a number`)
  return parsed
}
const triple = (value, what = 'vector') => {
  const list = Array.isArray(value) ? value.map(num) : String(value).trim().split(/\s+/).filter(Boolean).map(num)
  if (list.length !== 3) throw new Error(`blockMesh spec: ${what} must have three components, got ${JSON.stringify(value)}`)
  return list
}
const fmt = (value) => (Number.isInteger(value) ? String(value) : String(Number(value.toPrecision(12))))
const fmtPoint = (point) => `(${point.map(fmt).join(' ')})`
const faceText = (face) => {
  if (Array.isArray(face)) return `(${face.map((n) => Math.floor(num(n))).join(' ')})`
  if (face && typeof face === 'object' && Number.isInteger(face.block) && Number.isInteger(face.face)) {
    return `(${face.block} ${face.face})`
  }
  throw new Error(`blockMesh spec: a face must be four vertex indices or {block, face}, got ${JSON.stringify(face)}`)
}
const gradingText = (grading) => {
  if (grading == null) return 'simpleGrading (1 1 1)'
  if (typeof grading === 'string') return grading.replace(/\s+/g, ' ').trim()
  const axis = (value) => (value == null ? '1 1 1' : (Array.isArray(value) ? value : String(value).split(/\s+/)).map((v) => fmt(num(v))).join(' '))
  return `simpleGrading (${axis(grading.x)} ${axis(grading.y)} ${axis(grading.z)})`
}

/** Text for a blockMeshDict from a spec. Deterministic: same spec, same bytes. */
export function blockMeshSpecDict(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('blockMesh spec must be an object')
  const vertices = (spec.vertices ?? []).map((entry, index) => {
    // A vertex may itself be projected onto a geometry surface: `project ( x y z ) ( sphere )`.
    if (entry && !Array.isArray(entry) && entry.project) {
      return `    project ${fmtPoint(triple(entry.point, `vertices[${index}].point`))} ( ${entry.project} )`
    }
    return `    ${fmtPoint(triple(entry, `vertices[${index}]`))}`
  })
  if (!vertices.length) throw new Error('blockMesh spec needs vertices[]')
  const blocks = (spec.blocks ?? []).map((block, index) => {
    const hex = block.hex ?? block.vertices
    if (!Array.isArray(hex) || hex.length !== 8) throw new Error(`blockMesh spec: blocks[${index}].hex must list 8 vertex indices`)
    const cells = block.cells ?? block.nCells
    if (!Array.isArray(cells) || cells.length !== 3) throw new Error(`blockMesh spec: blocks[${index}].cells must be [nx,ny,nz]`)
    return `    hex (${hex.join(' ')})${block.zone ? ` ${block.zone}` : ''} (${cells.map((n) => Math.max(1, Math.floor(num(n)))).join(' ')}) ${gradingText(block.grading)}`
  })
  if (!blocks.length) throw new Error('blockMesh spec needs blocks[]')
  const edges = (spec.edges ?? []).map((edge, index) => {
    const type = String(edge.type ?? 'line')
    const points = (edge.points ?? []).map((n) => Math.floor(num(n)))
    if (points.length < 2) throw new Error(`blockMesh spec: edges[${index}].points must list at least two vertex indices`)
    switch (type) {
      case 'arc':
        if (edge.arc) return `    arc ${points.join(' ')} ${fmtPoint(triple(edge.arc, `edges[${index}].arc`))}`
        if (edge.origin) return `    arc ${points.join(' ')} origin ${edge.factor != null ? `${fmt(num(edge.factor))} ` : ''}${fmtPoint(triple(edge.origin, `edges[${index}].origin`))}`
        if (edge.interpolate) return `    arc ${points.join(' ')} ${edge.interpolate.map((pt) => fmtPoint(triple(pt))).join(' ')}`
        throw new Error(`blockMesh spec: edges[${index}] is an arc but has no arc/origin/interpolate points`)
      case 'spline': return `    spline ${points.length} (${points.join(' ')}) ${(edge.interpolate ?? []).map((pt) => fmtPoint(triple(pt))).join(' ')}`
      case 'project': {
        if (!edge.name) return `    project ${points.join(' ')}`
        const name = String(edge.name)
        // blockMesh reads a *list* of surface names: `project 8 9 ( sphere )`; a bare word is invalid.
        return `    project ${points.join(' ')}${edge.list || name.includes(' ') ? ` ( ${name} )` : ` ${name}`}`
      }
      case 'line': return `    line ${points.join(' ')}`
      default: throw new Error(`blockMesh spec: edges[${index}].type "${type}" is not in the subset (arc|spline|project|line)`)
    }
  })
  const faces = (spec.faces ?? []).map((entry, index) => {
    const target = entry.project ?? entry
    if (!target || typeof target !== 'object') throw new Error(`blockMesh spec: faces[${index}] needs {project:{block,face}, name}`)
    return `    project ${faceText(target)} ${entry.name}`
  })
  const boundary = Object.entries(spec.boundary ?? {})
  if (!boundary.length) throw new Error('blockMesh spec needs boundary{}')
  const boundaryText = boundary.map(([patch, entry]) => {
    const patchFaces = (entry.faces ?? []).map(faceText)
    // An empty face list is legal (blockMesh creates `defaultFaces` this way in the mergePairs tutorial).
    return `    ${patch}\n    {\n        type ${entry.type ?? 'patch'};\n`
      + (Array.isArray(entry.inGroups) && entry.inGroups.length ? `        inGroups (${entry.inGroups.join(' ')});\n` : '')
      + `        faces\n        (\n${patchFaces.map((text) => `            ${text}`).join('\n')}\n        );\n    }`
  }).join('\n')
  const merge = Array.isArray(spec.mergePatchPairs) && spec.mergePatchPairs.length
    ? `\nmergePatchPairs\n(\n${spec.mergePatchPairs.map((pair) => {
      if (!Array.isArray(pair) || pair.length !== 2) throw new Error('blockMesh spec: mergePatchPairs entries must be [master, slave]')
      return `    (${pair[0]} ${pair[1]})`
    }).join('\n')}\n);\n`
    : ''
  const geometry = Object.entries(spec.geometry ?? {})
  const geometryText = geometry.length
    ? `geometry\n{\n${geometry.map(([name, entry]) => {
      const entries = Object.entries(entry.entries ?? {})
      return `    ${name}\n    {\n${entries.map(([key, value]) => `        ${key} ${value};`).join('\n')}\n    }`
    }).join('\n')}\n}\n\n`
    : ''
  const scale = spec.scale != null ? `scale ${fmt(num(spec.scale))};` : `convertToMeters ${fmt(num(spec.convertToMeters ?? 1))};`
  return `/*--------------------------------*- C++ -*----------------------------------*\\
| =========                 |                                                 |
| \\\\      /  F ield         | OpenFOAM: The Open Source CFD Toolbox           |
|  \\\\    /   O peration     | blockMeshDict from a blockmesh-spec/1 document   |
|   \\\\  /    A nd           |                                                 |
|    \\\\/     M anipulation  |                                                 |
\\*---------------------------------------------------------------------------*/
FoamFile
{
    version     2.0;
    format      ascii;
    class       dictionary;
    object      blockMeshDict;
}
// * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * * //

${scale}

${geometryText}vertices
(
${vertices.join('\n')}
);

blocks
(
${blocks.join('\n')}
);

edges
(
${edges.join('\n')}
);

${faces.length ? `faces\n(\n${faces.join('\n')}\n);\n\n` : ''}boundary
(
${boundaryText}
);
${merge}
// ************************************************************************* //
`
}

/**
 * Normalise the padding `foamDictionary -expand` leaves behind: `- 0.57735` becomes `-0.57735`.
 * Newlines are kept — they separate entries inside edges/faces lists that carry no semicolons.
 */
function normalize(text) {
  return String(text)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/-\s+(\d)/g, '-$1')
}

/** Body of the first `key ( ... )` group, with balanced parentheses (dictionary text is not regular). */
function parenBody(text, key) {
  const index = text.search(new RegExp(`(^|[\\s;])${key}\\s*\\(`))
  if (index < 0) return null
  const open = text.indexOf('(', index)
  let depth = 0
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1
    else if (text[i] === ')') {
      depth -= 1
      if (depth === 0) return text.slice(open + 1, i)
    }
  }
  throw new Error(`blockMeshDict: unbalanced parentheses in ${key}(...)`)
}

const numbers = (text) => String(text).trim().split(/\s+/).filter(Boolean).map((n) => Math.floor(num(n)))

/** Parse the blockMesh subset back into a spec (round-trip and tutorial-oracle support). */
export function parseBlockMeshDict(text) {
  const source = normalize(text)
  const spec = { schema: BLOCKMESH_SCHEMA, vertices: [], blocks: [], edges: [], boundary: {}, mergePatchPairs: [] }
  const scale = source.match(/\b(?:scale|convertToMeters)\s+([-+0-9.eE]+)\s*;/)
  if (scale) spec.scale = num(scale[1])

  // geometry { name { type X; key value; } ... } — values stay verbatim so projection surfaces survive.
  const geometryIndex = source.search(/(^|\s)geometry\s*\{/)
  if (geometryIndex >= 0) {
    const open = source.indexOf('{', geometryIndex)
    let depth = 0
    let close = -1
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1
      else if (source[i] === '}') {
        depth -= 1
        if (depth === 0) { close = i; break }
      }
    }
    if (close < 0) throw new Error('blockMeshDict: unbalanced braces in geometry{}')
    const body = source.slice(open + 1, close)
    spec.geometry = {}
    for (const match of body.matchAll(/([A-Za-z_]\w*)\s*\{([\s\S]*?)\}/g)) {
      const entries = {}
      for (const entry of match[2].matchAll(/([A-Za-z_]\w*)\s+([^;]+);/g)) entries[entry[1]] = entry[2].replace(/\s+/g, ' ').trim()
      spec.geometry[match[1]] = { type: entries.type ?? 'unknown', entries }
    }
  }

  const verticesBody = parenBody(source, 'vertices')
  if (!verticesBody) throw new Error('blockMeshDict: no vertices(...) block')
  if (/\bproject\b/.test(verticesBody)) {
    const projected = [...verticesBody.matchAll(/project\s*\(([^)]*)\)\s*\(([^)]*)\)/g)]
    for (const match of projected) spec.vertices.push({ point: triple(match[1]), project: match[2].trim().split(/\s+/).join(' ') })
    const leftover = verticesBody.replace(/project\s*\(([^)]*)\)\s*\(([^)]*)\)/g, ' ').replace(/[\s;]+/g, ' ').trim()
    if (leftover) throw new Error(`blockMeshDict: vertices(...) mixes projected and plain entries: "${leftover.slice(0, 100)}"`)
  } else {
    for (const match of verticesBody.matchAll(/\(([-+0-9.eE\s]+?)\)/g)) spec.vertices.push(triple(match[1]))
  }

  const blocksBody = parenBody(source, 'blocks')
  if (!blocksBody) throw new Error('blockMeshDict: no blocks(...) block')
  // Entries carry no trailing semicolons inside blocks(...); each one starts with `hex`. Splitting on the
  // keyword keeps the parser independent of how the writer spaces the numbers.
  const blockChunks = blocksBody.split(/\bhex\b/).slice(1)
  for (const chunk of blockChunks) {
    const groups = [...chunk.matchAll(/\(([^)]*)\)/g)]
    if (groups.length < 3) throw new Error(`blockMeshDict: a hex block has fewer than three (...) groups: "${chunk.trim().slice(0, 100)}"`)
    const hex = numbers(groups[0][1])
    const cells = numbers(groups[1][1])
    const between = chunk.slice(groups[0].index + groups[0][0].length, groups[1].index).trim()
    const zone = /^[A-Za-z_]\w*$/.test(between) ? between : undefined
    const gradingMatch = chunk.slice(groups[1].index + groups[1][0].length).match(/^\s*(simpleGrading|edgeGrading|grading)\s*\(([^)]*)\)/)
    if (hex.length !== 8) throw new Error(`blockMeshDict: hex block with ${hex.length} vertices (wants 8)`)
    if (cells.length !== 3) throw new Error(`blockMeshDict: hex block with ${cells.length} divisions (wants 3)`)
    spec.blocks.push({
      hex,
      cells,
      ...(zone ? { zone } : {}),
      ...(gradingMatch ? { grading: `${gradingMatch[1]} (${gradingMatch[2].trim()})` } : {}),
    })
  }
  if (!spec.blocks.length) throw new Error('blockMeshDict: no hex blocks parsed')

  const edgesBody = parenBody(source, 'edges')
  if (edgesBody && edgesBody.trim()) {
    const consumed = []
    const take = (regex, build) => {
      for (const match of edgesBody.matchAll(regex)) {
        consumed.push(match[0])
        spec.edges.push(build(match))
      }
    }
    take(/arc\s+(\d+)\s+(\d+)\s+origin\s+([-+0-9.eE]+)\s*\(([^)]*)\)/g, (m) => ({
      type: 'arc', points: numbers(`${m[1]} ${m[2]}`), origin: triple(m[4]), factor: num(m[3]),
    }))
    take(/arc\s+(\d+)\s+(\d+)\s+origin\s*\(([^)]*)\)/g, (m) => ({ type: 'arc', points: numbers(`${m[1]} ${m[2]}`), origin: triple(m[3]) }))
    take(/arc\s+(\d+)\s+(\d+)\s+(\d+)\s*\(((?:\s*\([^)]*\))+)\s*\)/g, (m) => ({
      type: 'arc', points: numbers(`${m[1]} ${m[2]} ${m[3]}`),
      interpolate: [...m[4].matchAll(/\(([^)]*)\)/g)].map((pt) => triple(pt[1])),
    }))
    take(/arc\s+(\d+)\s+(\d+)\s*\(([^)]*)\)/g, (m) => ({ type: 'arc', points: numbers(`${m[1]} ${m[2]}`), arc: triple(m[3]) }))
    take(/spline\s+(\d+)\s*\(([^)]*)\)((?:\s*\([^)]*\))*)/g, (m) => ({
      type: 'spline',
      points: numbers(m[2]),
      interpolate: [...m[3].matchAll(/\(([^)]*)\)/g)].map((pt) => triple(pt[1])),
    }))
    take(/project\s+(\d+)\s+(\d+)\s+(\d+)\s+(\w+)/g, (m) => ({ type: 'project', points: numbers(`${m[1]} ${m[2]} ${m[3]}`), name: m[4] }))
    take(/project\s+(\d+)\s+(\d+)\s*\(([^)]*)\)/g, (m) => ({
      type: 'project', points: numbers(`${m[1]} ${m[2]}`), name: m[3].trim().split(/\s+/).join(' '), list: true,
    }))
    take(/project\s+(\d+)\s+(\d+)\s+(\w+)/g, (m) => ({ type: 'project', points: numbers(`${m[1]} ${m[2]}`), name: m[3] }))
    const leftover = consumed.reduce((rest, chunk) => rest.replace(chunk, ' '), edgesBody).replace(/[\s;]+/g, ' ').trim()
    if (leftover) throw new Error(`blockMeshDict: edges(...) has entries outside the subset: "${leftover.slice(0, 120)}"`)
  }

  const boundaryIndex = source.search(/(^|\s)boundary\s*\(/)
  const facesBody = parenBody(boundaryIndex > 0 ? source.slice(0, boundaryIndex) : source, 'faces')
  if (facesBody && facesBody.trim()) {
    spec.faces = []
    for (const match of facesBody.matchAll(/project\s*\(\s*(\d+)\s+(\d+)\s*\)\s*(\w+)/g)) {
      spec.faces.push({ project: { block: Number(match[1]), face: Number(match[2]) }, name: match[3] })
    }
    const leftover = facesBody.replace(/project\s*\(\s*\d+\s+\d+\s*\)\s*\w+/g, ' ').replace(/[\s;]+/g, ' ').trim()
    if (leftover || !spec.faces.length) throw new Error(`blockMeshDict: faces(...) entries outside the subset: "${leftover.slice(0, 120) || facesBody.slice(0, 120)}"`)
  }

  const boundaryBody = parenBody(source, 'boundary')
  if (!boundaryBody) throw new Error('blockMeshDict: no boundary(...) block')
  const patchRe = /([A-Za-z_]\w*)\s*\{([\s\S]*?)\}(?=\s*[A-Za-z_]|\s*$)/g
  for (const match of boundaryBody.matchAll(patchRe)) {
    const [, patch, body] = match
    const type = body.match(/type\s+([A-Za-z]+)\s*;/)?.[1] ?? 'patch'
    const inGroups = body.match(/inGroups\s*\(([^)]*)\)/)?.[1].trim().split(/\s+/).filter(Boolean)
    const facesText = parenBody(body, 'faces') ?? ''
    const patchFaces = []
    for (const pair of facesText.matchAll(/\(\s*(\d+)\s+(\d+)\s*\)/g)) patchFaces.push({ block: Number(pair[1]), face: Number(pair[2]) })
    const withoutPairs = facesText.replace(/\(\s*\d+\s+\d+\s*\)/g, ' ')
    for (const quad of withoutPairs.matchAll(/\(([^)]*)\)/g)) {
      const indices = numbers(quad[1])
      if (indices.length !== 4) throw new Error(`blockMeshDict: boundary.${patch} has a face with ${indices.length} vertices (blockMesh wants four)`)
      patchFaces.push(indices)
    }
    spec.boundary[patch] = { type, faces: patchFaces, ...(inGroups && inGroups.length ? { inGroups } : {}) }
  }
  if (!Object.keys(spec.boundary).length) throw new Error('blockMeshDict: no boundary patches parsed')

  const mergeBody = parenBody(source, 'mergePatchPairs')
  if (mergeBody && mergeBody.trim()) {
    spec.mergePatchPairs = [...mergeBody.matchAll(/\(([^)]+)\)/g)]
      .map((m) => m[1].trim().split(/\s+/).filter(Boolean))
      .filter((pair) => pair.length === 2)
  }
  return spec
}

/** Read + parse a blockMeshDict file (run `foamDictionary -expand` first when it uses macros). */
export function readBlockMeshSpec(file) {
  return parseBlockMeshDict(readFileSync(file, 'utf8'))
}

/** The numbers that decide the mesh, for an oracle comparison. */
export function blockMeshFingerprint(spec) {
  return {
    // `schema` is metadata, not mesh content: a hand-written spec need not carry it, and it must not
    // make two identical meshes compare unequal.
    scale: spec.scale ?? null,
    vertices: spec.vertices.map((entry) => (entry && !Array.isArray(entry) && entry.project
      ? { project: entry.project, point: entry.point.map((v) => Number(v.toPrecision(9))) }
      : entry.map((v) => Number(v.toPrecision(9))))),
    blocks: spec.blocks.map((block) => ({ hex: block.hex, cells: block.cells, zone: block.zone ?? null, grading: block.grading ?? null })),
    edges: (spec.edges ?? []).map((edge) => ({
      type: edge.type, points: edge.points, arc: edge.arc ?? null, origin: edge.origin ?? null,
      factor: edge.factor ?? null, interpolate: edge.interpolate ?? null, name: edge.name ?? null, list: edge.list ?? false,
    })),
    geometry: Object.entries(spec.geometry ?? {}).map(([name, entry]) => ({ name, type: entry.type, entries: entry.entries })),
    faces: (spec.faces ?? []).map((entry) => ({ block: entry.project?.block ?? null, face: entry.project?.face ?? null, name: entry.name ?? null })),
    boundary: Object.entries(spec.boundary).map(([name, entry]) => ({ name, type: entry.type, faces: entry.faces, inGroups: entry.inGroups ?? [] })),
    mergePatchPairs: spec.mergePatchPairs,
  }
}

/** Structured equality of two fingerprints (JSON compare is enough: keys are emitted in a fixed order). */
export function fingerprintsEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b)
}
