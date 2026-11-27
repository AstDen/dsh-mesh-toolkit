# Changelog

## 1.2.0 — 2026-11-27

Second half of the plan S3 defect sprint (audit `AUDIT-implementation-map-2026-11-26.md`, items D-2, D-3, D-4, D-8, D-9)
plus the follow-up found while proving D-6 on a real mesh.

- **D-3 — `nCellsBetweenLevels` was hard-coded to 4.** `scaffoldOptions.nCellsBetweenLevels` (integer 1..10) now
  reaches `snappyHexMeshDict`; anything else is refused with `nCellsBetweenLevels must be an integer 1..10 (got …)`.
- **D-2 — no `refinementRegions` block.** `scaffoldOptions.refinementRegions` takes `{name, type: 'box'|'sphere',
  min/max | centre/radius, mode: 'inside'|'outside', level}` and writes `searchableBox`/`searchableSphere` entries
  next to `advanced.directional`. A region that does not intersect the domain, a box with `min >= max`, a
  non-positive radius or an unknown mode is refused with the index of the offending entry.
- **D-4 — the relaxed snap pass was switched off.** `relaxed { maxNonOrtho 180; }` never relaxed anything; the
  default is now `min(89, maxNonOrtho + 15)` (80 with the built-in 65), overridable with
  `scaffoldOptions.relaxedMaxNonOrtho`.
- **D-8 — a fluid point only from python.** New `lib/fluidpoint.js` (`suggestFluidPoint`, deterministic lattice +
  nearest-triangle classification, no numpy): when `scaffold: true` runs without `locationInMesh`, the scaffold
  picks the point itself, the answer carries `locationInMeshSource: 'auto (lattice+nearest-triangle)'` and
  `fluidPoint {point_mm, clearance_mm}`, and a warning states where the point is. `autoFluidPoint: false` keeps the
  old explicit requirement; `autoFluidClearanceMm` (0.1 mm) and `autoFluidSeed` tune it.
- **D-9 — one rung per advice category.** Seven categories now have a second measured rung (`layers.thickness`,
  `snap.smooth`, `layers.yplusRelax`, `domain.mode` are new ops, `resolution`/`cells-budget` gain a second step);
  `domain` ceiling raised to 2 so the second rung is reachable.
- **Gate retry, measured (follow-up to D-6).** `h_min^3/6` describes the intended cell, but snappy also makes
  thinner boundary cells: a single illegal face pyramid proved it on a plain 10 mm cube at 40 000 target cells
  (`h_min` 1.11 mm → `minVol 4.6e-11`, one face below). The wrapper now retries at checkMesh's own advice
  (`minVolume / 12`) and, if the mesh is still on the edge, once more at half of it — at most two attempts,
  `minVolSource: 'derived-then-measured'`. Measured: `4.6e-11` FAIL (1 illegal face), `2e-11` PASS; the retry lands
  on `2.3e-11` and the case PASSes.
- **Tests**: `test/refinement.test.mjs` (8), `test/fluidpoint.test.mjs` (6), `test/ladders.test.mjs` (8) — suite
  **93 tests, 91 pass, 0 fail, 2 skipped** (the two skips need `MESH_TUTORIALS_ROOT`).

## 1.1.1 — 2026-11-27

Defect sprint on the gate (plan S3; audit `AUDIT-implementation-map-2026-11-26.md`, items D-6, D-7, D-10, D-1).

- **D-6 — an absolute `minVol` was never right for every mesh.** New `lib/minvol.js`: `deriveMinVol(caseDir)` takes
  `h_min` from the handoff (`selection.cellSize_m / 2^maxLevel`, `source: 'handoff-cellSize'`) and falls back to
  `system/meshQualityDict` (`source: 'case-meshQualityDict'`); `minVolFromSetup` does the same from a scaffold
  (`source: 'scaffold-cellSize'`). Measured run: derived `1.76e-11` flagged healthy snappy boundary cells
  (`minVol 1.76e-11 looks too strict: try 8.7e-13`), so the wrapper now makes **one measured tightening pass** —
  when the only failures are `minVol-threshold` it re-runs the gate at the reported suggestion
  (`minVolSource: 'derived-then-tightened'`, `minVolDerivation` kept) instead of inventing a safety factor.
  Verified: the layered 10 mm case PASSes at `8.7e-13`, the same case re-checked by `mesh_check` derives `1e-14`
  from its own dictionary.
- **D-7 — layer coverage was never measured.** `parseCheckMesh` now also returns `layersFaces`
  (`Extruding N out of M faces (P%)`); new `parseLayerFaces(text)` in `sim-core/lib/checkmesh.js` reads it from a
  snappy log, because `checkMesh` only reports `Added … cells`. Measured: `2756/2768` faces = `99.57 %`.
- **D-10 — `minLayerCoverage` decided nothing.** New `layerCoverageCheck({layersFaces, required})` in
  `sim-core/lib/gate.js` (`disabled` / `no-faces` / `ok` / `below`), wired into `gateTarget` and into the
  `mesh-build` wrapper, which now also returns `layers {faces, cells, required, status}`. Low-coverage proof on a
  real mesh: `FAIL … layer coverage 10% < 80% (Extruding 100 out of 1000 faces)`.
- **D-1 — the same card lived in two packages.** `mesh-stl/data/hints/snappy.json` moved out (owner:
  `mesh-build`); `scripts/check-catalogue.mjs` now fails on an id with two owners. Catalogue: 56 unique cards,
  `stl_hints` 12, `mesh_hints` 44.
- `mesh_check` merges the snappy cell summary into the gate's face block instead of replacing it, and reports
  `minVol`/`minVolSource` at the top level and per target.
- Unit suite 71 tests (69 pass, 2 skipped), `mesh-build/test/gate-defects.test.mjs` covers all four defects.

## 1.1.0 — 2026-11-26

OpenFOAM 2606/14 tutorials become a runnable oracle (`PLAN-tutorial-2606`, branch `tutorial-2606`).

New tool `mesh_tutorial` (registered in `index.js`, CLI `scripts/tutorial.mjs`):

- `list` — every case under `$WM_PROJECT_DIR/tutorials/mesh`, parsed from its own `Allrun`: 51 cases /
  51 `controlDict` on com2606, 9 on org14, with family, steps, utilities and `requires`.
- `run` — copies the case into the project, executes the parsed steps (file operations in JS with an
  inside-the-project guard, applications via `runBash` with the chosen build's bashrc), writes one log per
  step plus `tutorial-manifest.json` (steps, skipped, manual, mesh metrics, gate verdict), and stops before
  solvers in `mesh-only` mode. `np` must match `system/decomposeParDict`, otherwise an explicit refusal rather
  than a silent override; a serial plan ignores `np`. `mpirun` gets `--oversubscribe` when the MPI build needs
  it (probed from `mpirun --version`), so cases with more subdomains than cores run.
- `compare` — baseline drift: cells ±5 %, `maxNonOrtho` ±2°, patch set.
- `mesh-only` skips motion and field-reconstruction utilities and records the reason; foamy meshers that write
  into time directories (`foamyHexMesh/blob` → `82`) are promoted to `constant/polyMesh` before the gate and
  reported as `meshFromTimeDir`.

New capability matrix `data/capabilities.json` + `mesh_capabilities.matrix`: utilities × snappy keys × build
(com2606, com2512, org14) with `file:line` evidence; the live `command -v`/annotated-dict probe wins over the
declared table and every disagreement is reported.

`scaffoldOptions.advanced` — gap, curvature, leak, directional, zones, distributed, domainSurface and
`quality.writeFlags`. A key the build does not support is refused before any run (`curvature` on org14) or
downgraded with a warning and recorded in `skipped` (`gapMode` on org14). `writeFlags` belongs at the top level
of `snappyHexMeshDict`, not under `debug` — a live run proved the wrong place is a `FOAM FATAL IO ERROR`.

`mesh_check` accepts `writeFields`; see sim-core 1.1.0 for the gate side.

Engine routes: `blockmesh` (a `blockMeshDict` parses into a JSON spec, can be edited, written back and rebuilt —
round-trip verified on 6 of 7 `blockMesh` tutorials; `pipe` needs named vertices/`projectCurve`/`transform`) and
`ops` (14 mesh-surgery utilities plus `checkMesh` as gated steps). 14 new knowledge cards in
`data/hints/tutorial-2606.json`, all with `case:line` evidence.

Tests: 66 checks (65 pass, 1 environment skip) — dictionary texts for every advanced key, `blockMeshDict`
round-trip, `Allrun` parsing (env prefix, `-s`, nested scripts), the tutorial inventory, the capability matrix
against `PLAN` §2–§3, and the negative cases.

## 1.0.1 — 2026-11-26

- TODO: describe the changes

## 1.0.0 — 2026-11-26

First stable release: the geometry-and-mesh half of an agent-driven pore-scale workflow.

What it does, end to end: nine generator families or your own STL (millimetres, watertight) → an STL contract
check → snappyHexMesh, cfMesh or gmsh → a threshold gate whose verdict is read from the log text, with a
passport that detects a stale verdict → one-command delivery (OpenFOAM case + `.tar.gz` + Fluent `.msh` with a
round-trip check) → `handoff.json` for a solver-side agent.

The 1.0 line was accepted where it matters — on a machine with no project, no checkout and no project venv:
`doctor` READY (7 pass / 2 warn / 0 fail) and `demo` OK in 25.7 s from the single-package tarball, recorded in
`docs/ACCEPTANCE.md` together with the two defects that run found and fixed.

Numbers behind this release: 12 tools, 40 knowledge cards distilled from 20+ experiments, 34 unit checks on the
four mathematical modules, 37 contract checks (three tiers plus a workbench seam), a 61-case benchmark
(45 pass / 15 fail / 18 defects, all triaged) and four OpenFOAM builds probed through `mesh_capabilities`.

See `CHANGELOG.md` for 1.0.0-rc.1 … rc.3 and `docs/RELEASE-1.0.0.md` for the release summary.

## 1.0.0-rc.3 — 2026-11-26

Clean-user acceptance: install the package where no project, no checkout and no project venv exist, then run
`doctor` and `demo` literally as `docs/QUICKSTART.md` says. The run and its numbers are in
[`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md) (READY 7 pass / 2 warn, demo OK in 26.3 s, 148 288 cells, gate PASS).

Fix found by it:

- `scripts/demo.mjs` crashed in its own diagnostic when the generator failed before `missingOutputs` existed
  (`TypeError: Cannot read properties of undefined (reading 'slice')`), hiding the real cause.

## 1.0.0-rc.2 — 2026-11-26

Day-3 hardening of the quality loop, all covered by the new unit tests (`mesh-build/test/`, 34 checks).

Fixes found while writing them:

- `surfacecheck.js` wrote the debug STL through an unimported `writeFileSync` — `mesh_surface_check`
  with `keepStl: true` threw `ReferenceError` instead of exporting the surface. The import is there now.
- An **internal** domain of a closed body no longer trips the `world`-patch sanity check: the rule now
  requires at least one surviving non-`world` patch, because for `domain.type: "internal"` snappy
  legitimately consumes the whole `world` patch. Measured: a closed 10 mm box with a 3.5 mm sphere
  cavity meshes to 50256 cells, `mesh_check` PASS, one patch `cav`.
- The `locationInMesh` refusal says when the point looks like millimetres:
  `the point looks like millimetres: the case is in METRES, so divide by 1000 ((0.004 0.004 0.004))`.

Also: `scripts/bump.mjs` accepts an explicit prerelease version (`1.0.0-rc.2`), which the rc line needs.

## 1.0.0-rc.1 — 2026-11-26

First release candidate of the 1.0 line; the three packages are versioned together from here on.
Bundles everything from 0.7.0–0.7.5: the revision loop (`mesh_revise`), `mesh_first_layer`, domain modes
and unit suspicion in the scaffold (`domain`, `targetCells`, `assumeUnits`), `mesh_surface_check` (surface
fidelity from `polyMesh` in JS, clip detection), `mesh_capabilities` (probing the installed dictionaries),
and the T1–T6 contract suite with a workbench tier.

Packaging and docs for the release: `docs/QUICKSTART.md` (five verified calls, measured numbers),
`docs/TROUBLESHOOTING.md` (literal strings → cause → fix), the tier table in `docs/PACKAGING.md`.
No behaviour change relative to 0.7.5.

## 0.7.5 — 2026-11-26

Plan A9 of the workbench contract: the two-way acceptance suite runs in the repository.

- `scripts/contract-test.mjs` — three tiers, each printing `SKIP` with the reason instead of failing, so the
  script is useful on a laptop, in CI and on a machine with OpenFOAM:
  - library (always): `meshToolkit` apiVersion/refusals/singleton, `mesh-handoff/1` validation (gate FAIL, mm case,
    unknown role), plural role aliases, conflict/patch-not-found refusals on a synthetic case, the advice table
    (10 categories, y+ ladder, escalation options, route downgrade), unit suspicion;
  - tools (when the packages are importable): the metre/ambiguous-unit question through `mesh_build`;
  - OpenFOAM (when a bashrc resolves): T1 mesh→gate→handoff, T5 roles + unchanged recheck metrics, T6 a broken
    partial mesh is rebuilt, T2 y+ feedback → revise → rebuild with history.
- T3 independence: the packages import nothing from the workbench, checked by grepping the entry points and the
  handoff/service modules.
- `ROLE_ALIASES` and `normalizeRoles` are exported: the contract's `next[]` hands plural keys (`walls`) to a
  consumer, so the mapping is public API.

Acceptance: `node scripts/contract-test.mjs` 33/33 with all tiers; `--no-mesh` in CI (library tier only).

## 0.7.4 — 2026-11-26

Plan A8 of the workbench contract: the capability matrix is probed once and every dictionary key follows it.

- New `lib/caps.js` (`mesh-caps/1`): probes the installation in one `bash -c` run — version, executables
  (cfMesh, gmsh, foamyHexMesh, foamRun, mergeTol) and, through `$WM_PROJECT_DIR/etc/caseDicts/annotated`, the
  **dictionary keys of this build** (`scale` vs `convertToMeters`, `minMedialAxisAngle` vs `minMedianAxisAngle`,
  `locationsInMesh`, `castellatedBufferLayer`, `relativeSizes`). A version table lies for patched builds; the
  annotated dictionaries do not.
- `scaffold.js` writes the probed keys: `scale 1;` instead of the deprecated `convertToMeters` (the v1012 IOWarning
  is gone) and the layer axis key the build actually reads.
- `routes.js` `probeInstallation` delegates to the matrix, so step conditions and merge flags come from one source.
- New tool `mesh_capabilities`; `mesh_build` reports the same block as `caps`.
- Measured: com v2512/v2606 — cfMesh yes, `surfaceFeatureExtractDict`, `locationsInMesh` yes, `mergeTol` yes;
  org 14 — cfMesh no, `surfaceFeaturesDict`, no `locationsInMesh`, `foamRun` yes, `mergeTol` no.
- Fixes found while building it: bash rejects `key.snappy.foo=$(…)` as an assignment (dots are illegal in names) —
  the probe prints `printf` lines instead; the module needed `../../sim-core/lib/process.js`, not `../sim-core/…`.

Acceptance: `experiments/_scratch/verify-a8.mjs` 24/24.

## 0.7.3 — 2026-11-26

Plan A7 of the workbench contract: `mesh_surface_check` compares the meshed surface with the reference STL.

- Exports the patch surface **from `constant/polyMesh` in JS** — no `surfaceMeshTriangulate`, which OpenFOAM.com
  does not ship (ORG-only), and therefore no OpenFOAM environment at all.
- Compares bounding box, area, volume and an approximate Hausdorff distance (triangle-centroid sampling both ways,
  uniform grid with expanding-ring queries, ~10 ms per case).
- **PASS = bbox and Hausdorff within tol**; the area keeps its diagnostic role because a snapped voxel surface is
  stair-stepped and legitimately carries more area than the smooth STL (sphere r5: areaRel 0.46, Hausdorff 0.7 %).
- Catches a domain that clips the geometry: the benchmark E1 case gives `bboxRel 0.41` and FAIL with the advice to
  enlarge the domain (an A1-shaped case with a clipped cube gives the same verdict — the check is honest about it).
- STL units come from the handoff (`units.stl`, mm by default) and are converted to metres before the comparison.

Acceptance: `experiments/_scratch/verify-a7.mjs` 12/12.

## 0.7.2 — 2026-11-26

Plan A6 — the domain can be inferred instead of typed, and a suspicious STL asks about its units.

- `scaffoldOptions.domain {type: external|internal|wrap, margins, sizeFactor, flowAxis}` builds the box from the
  STL bbox: `external` uses multiples of L = max extent (upstream 3, downstream 5, lateral 3, vertical 3/3),
  `internal` is the bbox, `wrap` pads 0.1·L on every side. Explicit `domainMin`/`domainMax` stay authoritative
  and produce a warning when both are given.
- `scaffoldOptions.targetCells` derives the background cell size from the domain volume
  (`cellSize = (V/targetCells)^(1/3)`), so "about 60 000 cells" is a valid input; the answer says which cell size
  it picked.
- Unit suspicion: when the domain is inferred from the STL and the bbox exceeds 100 mm, `mesh_build` returns
  `needs_input` instead of building a 1000× too large box; `assumeUnits: "mm"` (or explicit domainMin/domainMax)
  continues.
- Scaffold warnings (domain mode, target cells, STL outside the domain, cell budget) now reach the tool answer —
  they used to stay inside `written.scaffold`.
- Measured: sphere r5 + `domain {type:"external"}` + `targetCells 60000` → derived box −35…55 × ±35 mm, 47×37×37
  background cells, snappy builds, gate PASS; `targetCells 16000` on the 40×20×20 mm box gives 1.0 mm cells and
  `cells [40,20,20]`.

## 0.7.1 — 2026-11-26

Plan A5 — first-layer sizing as a tool instead of a skill step.

- `mesh_first_layer`: y+ → layers (flat plate `Cf = 0.026·Re^(-1/7)`, `u_τ = U·√(Cf/2)`, `y⁺·ν/u_τ`,
  `δ = 0.37·L·Re^(-0.2)`, geometric growth over `coverage·δ`) returning dimensions, layer count and a ready
  `scaffoldOptions` block; inverse mode (`firstLayer`) reports the y+ a given thickness produces.
- The near-wall cell size is read from `handoff.json`, or from `blockMeshDict` + `polyMesh/points` +
  `snappyHexMeshDict` levels (`lib/firstlayer.js: caseCellSize`), because the scaffold writes `relativeSizes true`:
  an absolute `layerThickness` makes snappy drop every layer (`Extruding 0 out of N faces`). The tool warns when
  the relative final layer would fall below `minThickness 0.075`.
- `lib/revise.js` now shares the same correlation with `mesh_first_layer`, so the `yplus` revision and a manual
  calculation cannot diverge (the duplicate `skinFriction`/`firstLayerFromYPlus` copy is gone).
- Acceptance `experiments/_scratch/verify-a5.mjs`: 28/28 — hand-calculation parity (Re 6666.7, Cf 0.007391,
  u_τ 0.6079, 24.67 µm), inverse round-trip, refusals, and a real rebuild of the c2 case with the computed block
  (122 977 cells, 56 736 layers added, gate PASS at 59.97°).
- Known follow-up: the gate still ignores layer coverage (`minLayerCoverage 0.8` is only a profile field), so a
  layered mesh is judged on non-ortho/skew/minVol alone — plan A7/A9 territory.

## 0.7.0 — 2026-11-26

- **plan A3 (workbench contract)**: new tool `mesh_revise` turns a `mesh-feedback/1` document into the next
  revision of the mesh. The reaction table is data (`data/advice.json`): category → ladder of ops → ceiling,
  and the rung is counted from the `revision` entries in `handoff.json`. `apply:false` returns the plan,
  `apply:true` rebuilds with `mesh_build`, re-gates with `mesh_check`, and appends
  `{attempt, category, strategy, changes, verdict}` to history.
- Categories with real logic: `yplus` (firstLayer = yPlus·ν/uTau, layer count from the local cell size, and
  snappy's `minVol` lowered to `firstLayer³/6` — a gate-sized threshold silently removes every layer, DEF-10),
  `nonortho`/`skewness` (refine → fewer layers → one route downgrade snappy→cfmesh after three consecutive
  failures), `patch-roles` (delegates to `mesh_patch_types`), `resolution`, `domain`, `units`, `layers`,
  `cells-budget`, `stl-quality` (stops and asks for `stl_check` + cleanup). At the ceiling the tool returns
  `{ok:false, escalated:true, options:[...]}`.
- The snappy scaffold now accepts `expansionRatio` (default 1.5) and forwards it to `addLayersControls`.
- **Bug fix**: the layer block wrote `minMedianAxisAngle`; OpenFOAM v2512 reads `minMedialAxisAngle`, so any
  case with layers died at `addLayers` with `Entry 'minMedialAxisAngle' not found`. Layers now extrude
  (verified: 9 600/9 600 faces on a cube-in-box case, 66 241 → 122 977 cells).
- New knowledge card `revise-loop`; the bundled skill documents the tool and the feedback step.

## 0.6.1 — 2026-11-26

- **plan A2 (workbench contract)**: new tool `mesh_patch_types` assigns contract roles
  (inlet/outlet/wall/symmetry/empty/interface) to existing patches by retyping
  `constant/<region>/polyMesh/boundary` — a `.bak` backup, a before/after diff, and only the `type` line is
  rewritten (`nFaces`/`startFace`/`inGroups` untouched). It never splits faces: a single patch cannot become
  inlet+outlet without a face set (`topoSet` + `createPatch`), and the refusal says so.
- Refusals instead of guesses: an unknown patch name lists the available `name (type)`; one patch in two
  roles; `empty`/`cyclic`/`cyclicAMI` cannot become a flow boundary without rebuilding the mesh; `cyclic`/
  `wedge` need a neighbour patch or wedge geometry; a multi-region case must name `region`.
- Roles that the boundary file cannot express are kept in `handoff.json`: after retyping, inlet and outlet are
  both type `patch`, so the document carries the semantic assignment (and `mesh_check` carries it forward).
- `recheck:true` re-runs the gate and reports `sameAsRecorded` with the earlier cells/non-ortho/minVolume —
  patch types change what a solver sees, not the mesh metrics.
- Role keys accept the contract's plural forms (`walls`, `symmetries`, `interfaces`), so `next[]` args from
  `handoff.json` can be passed verbatim.
- New knowledge card `patch-roles` (hint id), and the bundled skill lists the tool.

## 0.6.0 — 2026-11-26

- **plan A1 (workbench contract)**: `mesh_check` and `mesh_deliver` now write `handoff.json`
  (`mesh-handoff/1`) into the case. The document carries only facts read from the case: `units.scale` from
  `snappyHexMeshDict geometry { scale }` (falling back to `blockMeshDict scale`/`convertToMeters`), domain
  bbox from `constant/polyMesh/points`, background cells and surface levels from the dictionaries, quality
  from the gate that just ran, every boundary patch with a contract `role`, the STL sha256, and `next[]`
  with the patch-retyping step while inlet/outlet are missing.
- `mesh_deliver` copies the handoff into the packaged `openfoam_<name>/` case (with `files.delivery` and a
  `history[]` event), so a solver-side workbench can read it without our tools.
- New `meshToolkit` service (`apiVersion: 1`, `plugins/sim-core/lib/toolkit.js`): registers `mesh`, `gate`,
  `deliver`, `hints`; the consumer resolves it at call time via `ctx.get('meshToolkit')`. Absent methods
  (`revise`, `patchTypes`) answer with a structured `{ok:false, error:'not-provided', hint}` instead of throwing.
- `simMesh` capability service also exposes `deliver`.

## 0.5.4 — 2026-11-26

- `files` now includes `docs/`: the `docs/PORTABLE.md` referenced by the README makes it into `npm pack`
  (previously the tarball shipped without it).
- `scripts/smoke.mjs` also passes without `sim-project.json`: in portable mode it checks the defaults
  (`project: "defaults"`, `caseRoot: "cases"`, gate profile `project`) instead of the "project not detected" failure.
- `engines.dsh` and the `@deepseek-ai/dsh-*` peer ranges are aligned to `>=0.2.2-rc.1 <0.3.0`
  (installed DSH 0.2.2-rc.5, the workbench declares the same minimum).
- Filled in the `repository` field (`git+https://github.com/AstDen/dsh-mesh-toolkit`, `directory: mesh-build`).
- CI: `.github/workflows/ci.yml` (node 20/24, syntax, card catalog, versions, smoke, QA parity,
  tarball completeness) and `.github/workflows/release.yml` on a tag — see `docs/PACKAGING.md`.

## 0.5.3 — 2026-11-26

### Added
- **Portable mode (plan 1.4).** `mesh_build`/`mesh_check`/`mesh_deliver` work without
  `sim-project.json`: the response carries `project: "defaults"` and `configured: false`, cases default to
  `./cases`, gate `project`. The `requireProject` gate no longer blocks calls.
- Bundled delivery: if the project has no `tools/deliver/make_delivery.sh`, `mesh_deliver` takes
  `scripts/deliver/make_delivery.sh` from the bundle (together with `scripts/qa/mesh_gate.sh` and
  `scripts/deliver/region_layout.py`). The delivery gate writes an overlay into `<outDir>/.gate`
  via `MESH_GATE_CACHE_DIR`.
- Knowledge card `portable-mesh-build`; the `docs/PORTABLE.md` document with the end-to-end scenario.

### Verified
- End-to-end run in an empty `/tmp` directory: primitive (12 tri) → `stl_check` PASS →
  `mesh_build` snappy 2584 cells → `mesh_check` gate PASS → `mesh_deliver` DELIVERED
  (`scriptOrigin` = package, 1.8 MB of artefacts).

## 0.5.2 — 2026-11-26

- **`scripts/fluid-point.py` in the package** — picking `locationInMesh` from an STL no longer requires the
  research project's `benchmark/scripts/` tree. The script is the same (bucket index, exact distance and
  side along one face, `--max-seconds` budget); `benchmark/scripts/fluid_point.py` remains a shim.
- `caseRoot` defaults to `cases` (without a profile — relative to the current directory), `next:` messages
  point to the packaged script.

## 0.5.1 — 2026-11-26

Fixes from the end-to-end benchmark `benchmark/runs/20261125-1805` (61 cases, 18 defects;
re-check — `experiments/_scratch/verify-fixes.mjs`, 15/15 PASS).

- **Guards instead of a silently wrong mesh** (`lib/precheck.js`, a new module):
  an STL shell outside the domain (binary and ASCII STL), a background-mesh budget
  (`maxCells`, 5e6 by default), cfMesh refusing on a unit mismatch
  (`surfaceTransformPoints -scale`), a sanity check "the mesh has no `world` patch" ⇒ `locationInMesh`
  landed inside a solid body.
- **`refinementLevels`**: a level pair `[min, max]` now passes into `snappyHexMeshDict`
  as `level (min max)` (DEF-12: the scalar API could not reproduce the project reference),
  an unknown key throws an error with the surface list (DEF-13).
- **`system/meshQualityDict` is written from the gate profile thresholds** (`maxNonOrtho`, `minVolRatio`,
  `minTwist`): snappy optimises against exactly the numbers the gate judges it by
  (exp-022: `minTwist -1` left twisted faces that the gate then rejected).
- **Gate**: minimal `fvSchemes`/`fvSolution` are synthesised into the overlay if the case has none
  (DEF-04: `mesh_build` on a cfMesh case returned `gate.verdict ERROR` with empty metrics),
  with an advisory "write the real ones before running the solver".
- **`mesh_check`**: passport freshness is evaluated BEFORE it is overwritten (DEF-09: `passport-stale`
  after editing `polyMesh/points` is no longer masked), the passport is stamped with the on-disk version.
- **Version in tool responses**: a `version {reported, onDisk, stale}` block + a "restart DSH" warning
  if the process loaded an old version (DEF-08).
- **Knowledge cards**: `mesh_hints` also registers the `mesh-stl` catalog — a single catalog of 33 cards
  (DEF-15/DEF-16: `openfoam-versions` was not found for org14/cfMesh queries).


## 0.5.0 — 2026-11-25

Cross-version OpenFOAM compatibility (com v2412…v2606, org v14):

- `sim-project.json → foam.installations` + `foam.default`; the tools accept `openfoam: "<id>|<bashrc>"`,
  by default — from the profile. The passport writes `environment {id, distribution, version, bashrc}`.
- `routes.js`: `probeInstallation` (cached by bashrc) — availability of every tool of the route, `mergeTol`,
  `surfaceFeatures`; `preflight` refuses before the run with a hint about where the tool exists.
- snappy route: `surfaceFeatureExtract` on com, `surfaceFeatures` on org; `-mergeTol` only where it exists.
- scaffold: an explicit `file "<name>.stl"` in geometry (an org14 requirement), `system/surfaceFeaturesDict`,
  `locationInMesh` for a single region instead of `locationsInMesh`.
- Verified (exp-019): a 10 mm cube on com2512 / com2606 / org14 — 2584 cells, PASS; org14 gives 25.21° versus 9.71°.
  `gmshToFoam` on com2512 and org14 — OK.

## 0.4.0 — 2026-11-25
New tool `mesh_deliver` — mesh delivery in two distributions.

- A wrapper around `tools/deliver/make_delivery.sh`: an openable OpenFOAM case with a real `constant/`
  and a `.foam` marker, `.tar.gz`, Fluent `.msh` + `read_mesh.jou` + `.zip`, a `delivery_<name>.{json,md}`
  report with checks (round-trip, CHT interface, volumes, gate, archives).
- Precondition — a fresh `mesh-passport.json` (`passport-missing` / `passport-stale`), `force:true`
  lifts the restriction, but the delivery gate still runs.
- `dryRun`, `gateProfile`, `minVol`, `regions`, `multiRegion`, `noCombinedMesh`, `skipAnsys`,
  `keepScratch`; automatic multi-region detection.
- `mesh_check` now writes `mesh-passport.json` with a PASS/FAIL verdict (it does not change the mesh) — the passport
  is the entry point to delivery; `passport-not-pass` blocks packing.
- Verified: v13_best (CHT, 575 757 cells, interface ok, both regions PASS, round-trip ok, 66.6 s)
  and FCC single-region (27 424 cells, 3.5 s); live guard checks: missing → force → stale → not-pass.

## 0.3.0 — 2026-11-25
The quality gate moved into `sim-core`, passports and the case manifest appeared.

- **The JS gate is authoritative:** `sim-core/lib/gate.js` writes a complete `meshQualityDict` (all 13 keys),
  makes an overlay `<case>/.mesh-gate/<target>`, runs `checkMesh -meshQuality` and issues the verdict
  **from the text** — `checkMesh` returns 0 even on `Failed N mesh checks`.
- **`minVol` is absolute and deliberate:** not set by the profile/call → `-1` is written into the dictionary
  (the check is disabled) and the result is flagged `disabled-minVol-not-configured`; on failure
  the suggestion `minVol = minVolume/12` is given. `minTetQuality = minVol/100`.
- **Profiles from the project profile:** the `gate`/`project`/`relaxed` thresholds can be overridden in
  `sim-project.json.gate.profiles`, while `gate.engine:"script"` + `gate.script` are left as an escape hatch
  to a bash script (parity with `tools/qa/mesh_gate.sh`).
- **Passport and manifest:** `case-manifest.json` is written after scaffold, `mesh-passport.json` after the gate
  (route, cells, regions, gate, sha256/size/mtime of the polyMesh). `mesh_check` shows passport freshness
  and any divergence between the recorded verdict and the current one.
- **`simMesh` service:** `build`/`check`/`hints` for the other plugins of the family.
- **Logs:** `checkMesh` writes `<case>/logs/checkMesh-<target>.log`; the overlay does not land in the project's `.cache`.

## 0.2.0 — 2026-11-23
Fixes from the benchmark `benchmark/verify-20261123-1851` (the score was 33/100, meshing was
blocked).

- **Blocker removed:** `mesh_build` failed on any `scaffold:true` with `STL not found: .../[object Object]`.
  `expandStlInputs()` returns `{files, missing}`, while `scaffold.js` expected an array. Now `index.js`
  parses the object, returns a structural error with the list of missing files, and `writeSnappyCase()`
  additionally accepts `{files:[...]}`.
- **Dry run became a real preflight:** `dryRun` runs `preflight()`, renders the commands through
  `renderCommand()` (the `unresolved` field), returns `problems`/`requires` and creates no directories.
  `cfmesh` without `system/meshDict` now says `missing system/meshDict (cfMesh dictionary)`.
- **`caseDir` input check:** `resolveCase({mustExist})` — the error `case directory not found: <path> — <reason>`
  before the run; `mesh_check` hints that a built case is required.
- **Case-local point in metres:** `scaffoldOptions.locationInMesh` accepts both `[x,y,z]`
  and `[{point:[x,y,z], name}]` (as the tool description promises).
- **Patches in the response:** a new `lib/patches.js` — `mesh_build` and `mesh_check` return `patches`
  (`{name, type, nFaces}` per region) and `notes`: a single type for all patches, `symmetry` (retype
  after meshing), absence of `patch`/`cyclic`.
- **Gate diagnostics:** the result carries `failKind`, `minVolSuggestion` and `advisory`. If only the
  absolute `minVol` is violated, the gate explains that the threshold does not scale with the mesh and gives a working
  value (`V_min/12`); if `face twist` is to blame — that these are slivers on gaps smaller than a cell.
- **Neighbouring plugin's cards:** `mesh_hints` sees the `mesh-stl` plugin's `data/hints` (hit@3 = 5/5).
- **Version checked against disk:** `versionInfo()` → `{reported, onDisk, stale}`.
- Smoke tests extended with regressions for every item listed above.

## 0.1.1 — 2026-11-23
- Portability: machine absolute paths removed from the README/examples; the Fluent licence server in the card replaced with a placeholder.
- The OpenFOAM environment is configurable: `openfoamRoots` / `MESH_BUILD_OPENFOAM_ROOTS` (the standard directories are the default).
- The gate overlay is resolved from `workRoot` rather than a hard-coded `/.cache/mesh-build/` path (works with a custom workRoot).
- Cards refined: `cfmesh-layers-tetra` (why 3D layers are not built in gmsh 4.15.2), `cfmesh-cartesian` (cfMesh as part of OpenFOAM), `units-mm` (three places with units).
- All numeric claims in the cards verified against `journal/` and `experiments/` (no discrepancies found).

## 0.1.0 — 2026-11-23
- First version: three tools, JSON data (knowledge cards + family/route registry).
- Assembled from the project journal `experiments/exp-000…exp-018` and ADRs `D-001…D-019`.
- Smoke tests without DSH (`scripts/smoke.mjs`).
