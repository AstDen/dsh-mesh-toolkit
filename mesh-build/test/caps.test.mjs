import test from 'node:test'
import assert from 'node:assert/strict'

import {
  CAPS_SCHEMA,
  CAPS_VERSION,
  PROBED_COMMANDS,
  capsSentence,
  capsSummary,
  clearCapsCache,
  distributionOf,
  probeCaps,
} from '../lib/caps.js'

test('distributionOf separates OpenCFD tags from .org majors', () => {
  assert.equal(distributionOf('14'), 'org')
  assert.equal(distributionOf('v14'), 'org')
  assert.equal(distributionOf('12'), 'org')
  assert.equal(distributionOf('v2512'), 'com')
  assert.equal(distributionOf('2512'), 'com')
  assert.equal(distributionOf('2606'), 'com')
  assert.equal(distributionOf(''), 'unknown')
  assert.equal(distributionOf(null), 'unknown')
  assert.equal(distributionOf('4.1'), 'unknown')
  assert.equal(distributionOf('devel'), 'unknown')
})

test('caps metadata names the schema and the commands it probes', () => {
  assert.equal(CAPS_SCHEMA, 'mesh-caps/1')
  assert.equal(CAPS_VERSION, 1)
  for (const command of ['blockMesh', 'snappyHexMesh', 'checkMesh', 'cartesianMesh', 'gmshToFoam', 'foamRun']) {
    assert.ok(PROBED_COMMANDS.includes(command), `${command} is not probed`)
  }
})

test('a missing bashrc is an answer, not an exception', () => {
  clearCapsCache()
  const caps = probeCaps({})
  assert.equal(caps.ok, false)
  assert.equal(caps.distribution, 'unknown')
  assert.equal(caps.error, 'no OpenFOAM bashrc')
  assert.match(caps.notes.join(' '), /no OpenFOAM bashrc/)
  assert.deepEqual(caps.commands, {})
})

test('probing is cached per bashrc until clearCapsCache', () => {
  clearCapsCache()
  const config = { openfoamBashrc: '' }
  const first = probeCaps(config)
  const second = probeCaps(config)
  assert.equal(first, second, 'the same config must return the cached object')
  clearCapsCache()
  assert.notEqual(probeCaps(config), first, 'clearCapsCache must drop the cache')
})

test('an unreadable bashrc fails with a note instead of throwing', () => {
  clearCapsCache()
  const caps = probeCaps({ openfoamBashrc: '/nonexistent/openfoam/etc/bashrc' })
  assert.equal(caps.ok, false)
  assert.equal(typeof caps.error, 'string')
  assert.ok(caps.error.length > 0)
  clearCapsCache()
})

test('capsSummary and capsSentence compress a probe result', () => {
  const caps = {
    ok: true,
    schemaVersion: CAPS_SCHEMA,
    bashrc: '/opt/openfoam/etc/bashrc',
    distribution: 'com',
    version: 'v2512',
    project: 'OpenFOAM',
    commands: { blockMesh: '/bin/blockMesh', cartesianMesh: '/bin/cartesianMesh', gmshToFoam: '/bin/gmshToFoam' },
    features: { cfmesh: true, gmsh: true },
    dictKeys: { blockMeshUnits: 'scale', featuresDict: 'surfaceFeatureExtractDict', layerAxis: 'minMedialAxisAngle' },
    dicts: { snappy: true, blockMesh: true },
    notes: [],
  }
  const summary = capsSummary(caps)
  assert.deepEqual(summary.commands, ['blockMesh', 'cartesianMesh', 'gmshToFoam'])
  assert.equal(summary.version, 'v2512')
  assert.equal(summary.dictKeys.layerAxis, 'minMedialAxisAngle')

  const sentence = capsSentence(caps)
  assert.match(sentence, /OpenFOAM v2512 \(com\)/)
  assert.match(sentence, /cfMesh yes/)
  assert.match(sentence, /layer key minMedialAxisAngle/)
  assert.match(sentence, /blockMesh key scale/)

  assert.equal(capsSummary(null), null)
  assert.match(capsSentence({ ok: false, error: 'boom' }), /unknown: boom/)
})
