# 1.1.0 — the OpenFOAM tutorial set as a mesh oracle

**Released:** 2026-11-27 · `mesh-build 1.1.0` · `mesh-stl 1.0.1` · `sim-core 1.1.0`

1.1.0 adds a way to check a mesh against something that was not written by this plugin: the
OpenFOAM `tutorials/mesh` cases. It also makes the capability probe answer with a matrix
instead of a handful of booleans, and exposes the snappy keys that the tutorials actually use.

## What is new

| area | change |
|---|---|
| `mesh_tutorial` (new tool) | `list` / `run` / `compare`. Reads a tutorial `Allrun` as executable steps without a shell; `mkdir`, `cp`, `restore0Dir`, `cleanTimeDirectories`, `foamDictionary -set`, `setSet` heredocs, `(cd X && ...)`, `USE_ARC=true runApplication ...` are interpreted; anything else becomes `manual[]` with the reason and line. `run` copies the case, executes the steps with per-step logs, runs the gate, writes `tutorial-manifest.json`. `compare` diffs cells ±5 %, `maxNonOrtho` ±2° and the patch set. |
| capability matrix | `mesh_capabilities` returns `matrix` built from `data/capabilities.json` (utilities × snappy keys × build), with `evidence` per row and `disagreements` between the declared table and the live probe. Verified on com2606, com2512 and org14 with **0 disagreements**. |
| `scaffoldOptions.advanced` | eight key groups: `gap`, `curvature`, `leak`, `directional`, `zones`, `distributed`, `domainSurface`, `quality.writeFlags`. A key that the installed build does not have is refused with the build name; `writeFlags` is written at the top level of `snappyHexMeshDict` (under `debug` it is a fatal IO error). |
| `mesh_check({ writeFields })` | `checkMesh -writeFields '(nonOrthoAngle)'` runs in the overlay and returns `writtenFields[]`; the overlay copies `0/` so the field never lands in the real case. |
| routes `ops` and `blockmesh` | `ops` runs 14 whitelisted utilities plus `checkMesh` as route steps, refusing a missing utility up front. `blockmesh` parses `blockMeshDict` into a JSON spec, rebuilds it and compares cells / points / faces / `maxNonOrtho` / patches — 6 of 7 `tutorials/mesh/blockMesh` cases round-trip exactly. |
| hints | 16 new cards from the tutorial corpus (`data/hints/tutorial-2606.json`), all `verified` with `file:line` evidence; the merged catalogue is 66 entries / 56 unique ids. |
| acceptance tests | `test/acceptance.test.mjs` pins the measured inventory (51 cases / 51 `controlDict`s on v2606, 9/9 on org14), the matrix and the org14 refusals. |

## Evidence

Unit tests, this machine:

```
node --test mesh-build/test/*.test.mjs
# tests 67  pass 65  fail 0  skipped 2   (2 need MESH_TUTORIALS_ROOT + MESH_OPENFOAM_BASHRC)
# with both set: tests 67  pass 67  fail 0  skipped 0
```

Tutorial oracle (full table in `experiments/exp-025_tutorial-2606/metrics.csv`):

| case | cells | maxNonOrtho | gate |
|---|---|---|---|
| `snappyHexMesh/flange` | 19 186 | 50.9531 | PASS |
| `snappyHexMesh/sphere_multiRegion` | 8 000 | 0 | PASS |
| `snappyHexMesh/block_with_curvature` | 9 413 | 25.2394 | PASS |
| `snappyHexMesh/rotated_block` (np=5) | 8 000 | 0 | PASS |
| `snappyHexMesh/insidePoints` (np=6) | 1 000 | 0 | PASS |
| `snappyHexMesh/sphere_gapClosure` (np=8, collated) | 25 042 | 48.0336 | PASS |
| `PDRblockMesh/box0` | 54 960 | 55.9662 | PASS |
| `extrudeMesh/polyline` | 51 400 | 32.4679 | PASS |
| `polyDualMesh/missingCorner` | 38 498 | 34.9906 | PASS |
| `foamyQuadMesh/square` | 14 349 | 26.7160 | PASS |
| `foamyQuadMesh/jaggedBoundary` | 42 361 | 50.5075 | PASS |

Cross-build parity: `flange`, `sphere_multiRegion`, `block_with_curvature` on com2512 vs com2606 →
`cellsDelta 0`, `nonOrthoDelta 0`.

Capability matrix (declared × live probe, 0 disagreements): com2606 — 26 of 27 utilities, 13 of 15 snappy keys;
com2512 — 26 / 14; org14 — 18 / 7. `outsidePoints` is absent from the com2606 annotated dictionary and
`minMedianAxisAngle` from all three builds (the key is `minMedialAxisAngle`).

## What does not change

- Every tool from 1.0.1 keeps its arguments and result shape. `mesh_check` still returns
  `PASS`/`FAIL`/`ERROR` from the log text, `mesh_deliver` still refuses without a fresh passport.
- No mesh numbers move: the scaffold keeps its previous dictionary content unless a new
  `advanced` key is requested. Byte-identical defaults are enforced by
  `test/advanced.test.mjs` ("default does not contain the keys").
- The published install story is unchanged: one package, `git+https://github.com/AstDen/dsh-mesh-toolkit.git#v1.1.0`.

## Known gaps

- `foamyHexMesh/flange` and `foamyHexMesh/simpleShapes` crash with `SIGFPE` inside
  `conformalVoronoiMesh::dualCellLargestSurfaceProtrusion` on v2606. Not a timeout; not fixed.
- `distributedTriSurfaceMesh` was not reproduced: 8 ranks need more RAM than the 31 GiB machine had free.
- 6 of 56 `Allrun` files carry steps outside the interpreted subset (`manual[]`); those cases are
  listed, not replayed.
- `mesh_tutorial` is a mesh oracle, not a solver runner: solver steps are marked `solver: true` and
  skipped under `steps: "mesh-only"`.
- The defects confirmed by `AUDIT-implementation-map-2026-11-26.md` (`minVol` policy, layer coverage
  by faces, dead `minLayerCoverage`, duplicated cards, y+ convention) are **not** part of 1.1.0; they
  are scheduled for 1.1.1 / 1.2.0.

## Install

```bash
dsh plugin --profile web add "git+https://github.com/AstDen/dsh-mesh-toolkit.git#v1.1.0"
```

Or add `https://raw.githubusercontent.com/AstDen/dsh-mesh-toolkit/master/market/index.json` as a
plugin-market index source. Then:

```
mesh_hints()                                // versionInfo 1.1.0, 66 entries
mesh_capabilities({ openfoam: "com2606" })  // matrix with evidence
mesh_tutorial({ action: "list" })           // 51 cases on v2606
```
