/**
 * Parser behaviour that only real tutorials exercise (TW-04/TW-06):
 *  - a leading `VAR=value` on a command line is an environment prefix for that one command
 *    (`USE_ARC=true runApplication -s arc extrudeMesh` in extrudeMesh/polyline), not an assignment;
 *  - a plain assignment without a command stays a variable (`fileHandler="-fileHandler collated"`);
 *  - `runApplication -s <suffix>` keeps the suffix, so the log and the case files do not collide.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { parseAllrun } from '../lib/tutorial.js'

function caseDirWith(files = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mesh-tutorial-parse-'))
  mkdirSync(join(dir, 'system'), { recursive: true })
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body)
  return dir
}

const ALLRUN = `#!/bin/sh
cd "\${0%/*}" || exit
. \${WM_PROJECT_DIR:?}/bin/tools/RunFunctions

touch case.foam
runApplication blockMesh
USE_ARC=true runApplication -s arc extrudeMesh
mkdir -p 1
runApplication -s arc checkMesh -writeAllFields -time 1
USE_ARC=false runApplication -s spline extrudeMesh
fileHandler="-fileHandler collated"
runApplication snappyHexMesh -overwrite $fileHandler
`

test('an environment prefix on runApplication becomes the env of that step, not a swallowed command', () => {
  const caseDir = caseDirWith()
  const parsed = parseAllrun(ALLRUN, { caseDir, tutorialsRoot: caseDir, cwd: '.', vars: {}, depth: 0 })
  const arc = parsed.steps.find((step) => step.util === 'extrudeMesh' && step.suffix === 'arc')
  assert.ok(arc, 'the USE_ARC=true line must produce an extrudeMesh step')
  assert.deepEqual(arc.env, { USE_ARC: 'true' })
  const spline = parsed.steps.find((step) => step.util === 'extrudeMesh' && step.suffix === 'spline')
  assert.deepEqual(spline.env, { USE_ARC: 'false' })
  assert.equal(parsed.manual.length, 0)
})

test('a bare assignment stays a variable and is expanded in later commands', () => {
  const caseDir = caseDirWith()
  const parsed = parseAllrun(ALLRUN, { caseDir, tutorialsRoot: caseDir, cwd: '.', vars: {}, depth: 0 })
  const snappy = parsed.steps.find((step) => step.util === 'snappyHexMesh')
  assert.deepEqual(snappy.args, ['-overwrite', '-fileHandler', 'collated'])
  assert.equal(snappy.env, undefined)
})

test('the -s suffix reaches the step and the log name', () => {
  const caseDir = caseDirWith()
  const parsed = parseAllrun(ALLRUN, { caseDir, tutorialsRoot: caseDir, cwd: '.', vars: {}, depth: 0 })
  const arcCheck = parsed.steps.find((step) => step.util === 'checkMesh')
  assert.equal(arcCheck.suffix, 'arc')
  assert.deepEqual(arcCheck.args, ['-writeAllFields', '-time', '1'])
})

const TUTORIALS_ROOT = process.env.MESH_TUTORIALS_ROOT
const OPENFOAM_BASHRC = process.env.MESH_OPENFOAM_BASHRC

test('a two-pass tutorial keeps both suffixed mesher steps and accepts keepGoing', { skip: !TUTORIALS_ROOT && 'set MESH_TUTORIALS_ROOT/MESH_OPENFOAM_BASHRC' }, async () => {
  const { runTutorial } = await import('../lib/tutorial.js')
  const { normalizeConfig } = await import('../lib/common.js')
  const config = normalizeConfig({ projectRoot: process.cwd(), openfoamBashrc: OPENFOAM_BASHRC })
  const out = await runTutorial(config, { case: 'snappyHexMesh/motorBike_leakDetection', np: 6, keepGoing: true, dryRun: true, steps: 'mesh-only' })
  assert.equal(out.ok, true, out.error)
  const meshers = out.steps.filter((step) => step.util === 'snappyHexMesh')
  // The tutorial runs snappy twice with different `useLeakClosure` and a suffix each time: a runner
  // that dropped the suffix would overwrite the first pass's log and mesh.
  assert.deepEqual(meshers.map((step) => step.suffix), ['leak', 'leak_and_closure'])
})
