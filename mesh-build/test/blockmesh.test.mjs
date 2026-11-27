/**
 * Unit tests for the blockMesh spec <-> dictionary pair (TW-03).
 *
 * The oracle here is the shipped tutorial family: every `tutorials/mesh/blockMesh` case that stays inside
 * the spec subset must survive parse -> generate -> parse byte-for-byte equivalent (fingerprint equal).
 * The dictionaries are expanded with `foamDictionary -expand` first when OpenFOAM is available; without
 * OpenFOAM the tests fall back to hand-written fixtures so they still run.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'

import {
  blockMeshFingerprint,
  blockMeshSpecDict,
  fingerprintsEqual,
  parseBlockMeshDict,
} from '../lib/blockmesh.js'

const FIXTURE = `FoamFile { version 2.0; format ascii; class dictionary; object blockMeshDict; }
scale 0.001;
vertices ( (0 0 0) (10 0 0) (10 10 0) (0 10 0) (0 0 10) (10 0 10) (10 10 10) (0 10 10) );
blocks ( hex (0 1 2 3 4 5 6 7) (2 2 2) simpleGrading (1 1 1) );
edges ( arc 0 1 (5 -1 0) );
boundary ( inlet { type patch; faces ( (0 4 7 3) ); } walls { type wall; faces ( (0 1 5 4) ); } );
mergePatchPairs ( );
`

test('a hand-written dictionary parses into the spec', () => {
  const spec = parseBlockMeshDict(FIXTURE)
  assert.equal(spec.scale, 0.001)
  assert.equal(spec.vertices.length, 8)
  assert.deepEqual(spec.vertices[1], [10, 0, 0])
  assert.equal(spec.blocks.length, 1)
  assert.deepEqual(spec.blocks[0].cells, [2, 2, 2])
  assert.equal(spec.blocks[0].grading, 'simpleGrading (1 1 1)')
  assert.equal(spec.edges.length, 1)
  assert.deepEqual(spec.edges[0], { type: 'arc', points: [0, 1], arc: [5, -1, 0] })
  assert.equal(spec.boundary.inlet.type, 'patch')
  assert.deepEqual(spec.boundary.inlet.faces, [[0, 4, 7, 3]])
  assert.equal(spec.boundary.walls.type, 'wall')
})

test('spec -> dictionary -> spec is stable (fingerprint equal, twice)', () => {
  const spec = parseBlockMeshDict(FIXTURE)
  const text = blockMeshSpecDict(spec)
  const again = parseBlockMeshDict(text)
  assert.ok(fingerprintsEqual(blockMeshFingerprint(spec), blockMeshFingerprint(again)))
  assert.ok(fingerprintsEqual(blockMeshFingerprint(again), blockMeshFingerprint(parseBlockMeshDict(blockMeshSpecDict(again)))))
})

test('the generator writes the block names, block-face references and merge pairs back', () => {
  const spec = {
    scale: 0.001,
    vertices: [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
      [2, 0, 0], [2, 1, 0], [2, 0, 1], [2, 1, 1]],
    blocks: [
      { hex: [0, 1, 2, 3, 4, 5, 6, 7], cells: [2, 2, 2], zone: 'left', grading: 'grading (1 1 1)' },
      { hex: [1, 8, 9, 2, 5, 10, 11, 6], cells: [3, 2, 2], grading: 'grading (1 1 1)' },
    ],
    edges: [{ type: 'project', points: [0, 1], name: 'sphere', list: true }],
    geometry: { sphere: { type: 'sphere', entries: { type: 'sphere', origin: '( 0 0 0 )', radius: '1' } } },
    faces: [{ project: { block: 0, face: 0 }, name: 'sphere' }],
    boundary: {
      mid6: { type: 'patch', faces: [{ block: 0, face: 5 }] },
      defaultFaces: { type: 'patch', faces: [] },
    },
    mergePatchPairs: [['mid6', 'defaultFaces']],
  }
  const text = blockMeshSpecDict(spec)
  assert.match(text, /hex \(0 1 2 3 4 5 6 7\) left \(2 2 2\) grading \(1 1 1\)/)
  assert.match(text, /project \(0 0\) sphere/)
  assert.match(text, /project 0 1 \( sphere \)/)
  assert.match(text, /geometry\n\{\n {4}sphere\n {4}\{\n {8}type sphere;/)
  assert.match(text, /\(0 5\)/)
  assert.match(text, /mergePatchPairs\n\(\n {4}\(mid6 defaultFaces\)/)
  const back = parseBlockMeshDict(text)
  assert.ok(fingerprintsEqual(blockMeshFingerprint(spec), blockMeshFingerprint(back)))
})

test('outside the subset: named vertices, projectCurve and transform are refused with the text', () => {
  const named = 'vertices ( name v0 project ( -1 -1 -1 ) ( cylinder ) ); blocks ( hex ( v0 v0 v0 v0 v0 v0 v0 v0 ) (1 1 1) grading (1 1 1) ); boundary ( b { type patch; faces ( ); } );'
  assert.throws(() => parseBlockMeshDict(named), /no hex blocks parsed|vertices\(\.\.\.\) mixes/)
  const projectCurve = 'vertices ( (0 0 0) (1 0 0) (1 1 0) (0 1 0) (0 0 1) (1 0 1) (1 1 1) (0 1 1) ); blocks ( hex (0 1 2 3 4 5 6 7) (1 1 1) grading (1 1 1) ); edges ( projectCurve 0 1 ( cylinder2 ) ); boundary ( b { type patch; faces ( (0 0) ); } );'
  assert.throws(() => parseBlockMeshDict(projectCurve), /outside the subset/)
  assert.throws(() => blockMeshSpecDict({ vertices: [[0, 0, 0]], blocks: [], boundary: {} }), /needs blocks\[\]/)
  const hex = { vertices: [[0, 0, 0], [1, 0, 0]], blocks: [{ hex: [0, 1], cells: [1, 1, 1] }], boundary: { b: { faces: [] } } }
  assert.throws(() => blockMeshSpecDict(hex), /must list 8 vertex indices/)
  assert.throws(() => blockMeshSpecDict({ blocks: [{ hex: [0, 1, 2, 3, 4, 5, 6, 7], cells: [1, 1, 1] }], boundary: {} }), /needs vertices\[\]/)
})

/**
 * The tutorial oracle: 6 of the 7 `tutorials/mesh/blockMesh` cases are inside the subset. Each one must
 * survive expand -> parse -> generate -> parse with an identical fingerprint. `blockMesh/pipe` uses named
 * projected vertices, `projectCurve` edges and `transform{}`, which the spec deliberately does not model.
 */
const IN_SUBSET = ['sphere', 'sphere7', 'sphere7ProjectedEdges', 'spheroid7Projected', 'spheroidProjected', 'mergePairs']

test('tutorial blockMesh dictionaries round-trip through the spec', { skip: !process.env.MESH_TUTORIALS_ROOT }, () => {
  const root = process.env.MESH_TUTORIALS_ROOT
  for (const name of IN_SUBSET) {
    const dict = `${root}/blockMesh/${name}/system/blockMeshDict`
    if (!existsSync(dict)) continue
    const expanded = existsSync(dict.replace('blockMeshDict', 'blockMeshDict.expanded'))
      ? readFileSync(dict.replace('blockMeshDict', 'blockMeshDict.expanded'), 'utf8')
      : tryExpand(dict)
    if (!expanded) continue
    const spec = parseBlockMeshDict(expanded)
    const roundTrip = parseBlockMeshDict(blockMeshSpecDict(spec))
    assert.ok(fingerprintsEqual(blockMeshFingerprint(spec), blockMeshFingerprint(roundTrip)), `${name}: fingerprint changed`)
  }
})

function tryExpand(dict) {
  const bashrc = process.env.MESH_OPENFOAM_BASHRC
  if (!bashrc) return null
  try {
    return execFileSync('bash', ['-c', `set -u; source ${bashrc} >/dev/null 2>&1; foamDictionary -expand ${dict}`], { encoding: 'utf8' })
  } catch {
    return null
  }
}
