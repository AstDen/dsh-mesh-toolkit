# mesh-build — DSH plugin for volume-mesh building

Four tools for the `Mesh_3D_pore_scale` project: meshing routes (snappyHexMesh, cfMesh, gmsh route D),
scaffolding a runnable snappy case from an STL, a quality verdict against the project thresholds, and
delivery as two distributions (an OpenFOAM case + a Fluent `.msh`). Every command is a real
OpenFOAM/cfMesh command on this machine, the logs stay on disk, and a short summary goes into the response.

## Tools

| Tool | What it does | Arguments |
|---|---|---|
| `mesh_hints` | knowledge cards: snappy, cfMesh/pMesh, gmsh route D, the gate, delivery, rejected routes | `query`, `id`, `limit` |
| `mesh_build` | route + case scaffold + gate | `route`, `caseDir`, `scaffold`, `stl`, `scaffoldOptions`, `np`, `splitRegions`, `gate`, `profile`, `minVol`, `overwrite`, `skipBlockMesh`, `dryRun`, `gmshScript`, `gmshArgs`, `msh` |
| `mesh_check` | JS gate per region; writes `mesh-passport.json`, leaves the mesh untouched | `caseDir`, `regions`, `profile`, `minVol` |
| `mesh_deliver` | delivery of a gate-passing mesh: OF case + `.tar.gz`, Fluent `.msh` + `.zip`, a report with the checks | `caseDir`, `name`, `outDir`, `gateProfile`, `minVol`, `regions`, `multiRegion`, `noCombinedMesh`, `skipAnsys`, `keepScratch`, `force`, `dryRun` |
| `mesh_first_layer` | y+ → layer sizing (flat plate: Cf, u_τ, first layer, δ, layer count) with a ready `scaffoldOptions` block; or the inverse: a known first layer → its y+ | `uRef`, `lRef`, `nu`, `yPlusTarget`, `expansionRatio`, `coverage`, `cellSize`, `layerSurfaces`, `firstLayer`, `caseDir` |
| `mesh_surface_check` | Fidelity of the built surface vs the reference STL: exports the patch faces from `constant/polyMesh` (JS, no OpenFOAM utility needed) and compares bbox, volume, area and an approximate Hausdorff; catches a domain that clips the geometry | `caseDir`, `stl`, `patches`, `region`, `tol`, `samples`, `keepStl` |
| `mesh_patch_types` | solver roles for existing patches (retype `boundary`, `.bak` + diff, updates `handoff.json`) | `caseDir`, `roles`, `region`, `dryRun`, `recheck`, `profile`, `minVol` |
| `mesh_revise` | plan A3: a `mesh-feedback/1` document becomes the next revision (advice table as data, rebuild + re-gate + history) | `caseDir`, `feedback`, `feedbackFile`, `attempt`, `apply`, `profile`, `minVol`, `np` |


## Description and topics

**Description** (`package.json` → `description`): volume meshes for the pore scale — snappyHexMesh
(hex-dominant, layers, multi-region CHT), cfMesh cartesianMesh, gmsh OCC conformal route D, checkMesh and a
strict quality gate per region with correct handling of the absolute `minVol`.

**Topics** (`package.json` → `keywords`): `openfoam`, `snappyhexmesh`, `cfmesh`, `gmsh`, `volume-mesh`,
`cht`, `quality-gate`, `checkmesh`, `pore-scale`, `minvol`.

**For the chat**: the tool `description`s in `index.js`, `description` + `whenToUse` in `lib/skill.js`, the
`plugin-mesh-build` card in `data/hints/plugin.json`; its `topics` = `keywords`.

Without `route` the tool lists routes, profiles and steps; without `query`, `mesh_hints` returns the card catalog.

## Installation

```json
{ "action": "install_bundle", "target": "<absolute path to the repository>/plugins/mesh-build" }
```

Substitute your own path — DSH accepts only an absolute one (`$(pwd)/plugins/mesh-build` from the project root).

This is the DSH `plugin_manager` tool (it requires confirmation): it adds a `link:` to the profile and
enables the bundle, so edits in `plugins/mesh-build/` are visible to the live session. Re-activation after
edits: `plugin_manager({ "action": "set_plugin", "target": "include:mesh-build" })`.
A check without DSH:

```bash
node plugins/mesh-build/scripts/smoke.mjs   # config, routes, cards, scaffold into tmp, serial/parallel plan
```

Requirements: Node ≥ 20, DSH `>= 0.2.2-rc.1 < 0.3.0`, OpenFOAM (ESI v2512; `etc/bashrc` is looked up in the
standard installation directories, an explicit path comes from `openfoamBashrc`/`MESH_BUILD_OPENFOAM_BASHRC`),
`tools/qa/mesh_gate.sh`, `tools/deliver/make_delivery.sh`, `mpirun` for parallel meshing.

## Configuration

```json
// ~/.config/mesh-build/config.json   (or $MESH_BUILD_CONFIG=/path/config.json)
{
  "projectRoot": "/path/to/Mesh_3D_pore_scale",
  "caseRoot": "cases",
  "workRoot": ".cache/mesh-build",
  "np": 6,
  "timeoutMs": 1800000
}
```

`projectRoot` can be omitted — it is searched upwards from the agent's working directory; `caseRoot`/`workRoot`
are paths **relative** to the project root (without a profile — relative to the current directory, `caseRoot`
defaults to `cases`).

Variables: `MESH_BUILD_PROJECT_ROOT`, `MESH_BUILD_PYTHON`, `MESH_BUILD_WORK_ROOT`,
`MESH_BUILD_CASE_ROOT`, `MESH_BUILD_NP`, `MESH_BUILD_TIMEOUT_MS`, `MESH_BUILD_CONFIG`,
`MESH_BUILD_OPENFOAM_BASHRC` and `MESH_BUILD_OPENFOAM_ROOTS` (extra installation directories, colon-separated).

## Routes (`data/engine.json`)

| route | steps | when |
|---|---|---|
| `snappy` | blockMesh → surfaceFeatureExtract → (decomposePar → snappy -parallel → reconstruct) or snappy serial → splitMeshRegions | pore STLs, CHT by `cellZones`, hex-dominant + layers |
| `cfmesh` | clean → decomposePar → cartesianMesh -parallel → reconstruct → clean processors (or serial) | a robust hex mesh when snapping is unstable |
| `gmsh` | `<python> <gmshScript> <gmshArgs>` → `gmshToFoam <msh> -case <case>` → splitMeshRegions | conformal CHT from OCC (route D) |
| `check` | — | only check an existing case |

The steps are declarative: `{ name, run, when, timeoutMs }`, `when` ∈ `always | blockMesh | features | parallel |
serial | splitRegions`. Placeholders: `{caseDir} {np} {msh} {python} {gmshScript} {gmshArgs}`. Logs go to
`<caseDir>/logs/plugin-<route>-NN-<step>.log`; on failure the response returns `failedStep` and `troubleshooting`
from the route's `failures`.

## The snappy scaffold

`mesh_build({ scaffold: true, stl: [...], scaffoldOptions: {...} })` writes a verified case:

- `system/{blockMeshDict,snappyHexMeshDict,meshQualityDict,surfaceFeatureExtractDict,decomposeParDict,controlDict,fvSchemes,fvSolution}`, `0/.keep`;
- the case is in **metres** (`convertToMeters 1`), the project STL in **mm** — `scale 0.001` is added to `geometry{}`;
- the outer domain boundary is `symmetry` (otherwise snapping moves points off the plane, exp-006/D-013);
- `locationsInMesh` from `locationInMesh`: `[x,y,z]` or `[{point:[x,y,z], name:"fluid"}]`, multi-region → `cellZones` → `splitMeshRegions`;
- `minVol` is absolute (`1e-14` by default, the rule `h_min³/6`), `maxNonOrtho` 65 in `meshQualityDict`;
- layers only for the listed `layerSurfaces`;
- if `locationInMesh` lands inside a closed solid body, the build stops (`phase: "sanity"`,
  "no `world` patch") — pick the point with `scripts/fluid-point.py`
  (`<python> scripts/fluid-point.py model.stl --clearance 0.1`).

`scaffoldOptions`: `domainMin`, `domainMax` (metres), `cells` or `cellSize` (metres), `locationInMesh`,
`refinementLevels {surface:level}`, `defaultLevel`, `layerSurfaces`, `nLayers`, `layerThickness`,
`minThickness`, `symmetryDomain`, `minVol`, `maxNonOrtho`, `resolveFeatureAngle`.

### Domain sizing without typing a box

Instead of `domainMin`/`domainMax` you can let the scaffold derive the box from the STL bounding box:

```js
scaffoldOptions: { domain: { type: "external" }, targetCells: 60000, locationInMesh: [-0.01, 0, 0] }
```

- `type: "external"` — multiples of `L` = the largest STL extent: upstream 3·L, downstream 5·L, lateral 3·L,
  vertical 3·L below and above (`flowAxis: "x"` by default). `type: "internal"` is the bbox itself,
  `type: "wrap"` pads 0.1·L on every side. Margins and `sizeFactor` override the multiples.
- Explicit `domainMin`/`domainMax` always win — the answer then carries a warning that the mode was ignored.
- `targetCells` picks the background cell size from the domain volume (`(V/targetCells)^(1/3)`); the answer
  says which cell size it used, and `cells: [nx,ny,nz]` still wins when given.
- **Unit suspicion**: if the inferred domain's STL bbox is wider than 100 mm, `mesh_build` answers `needs_input`
  ("is this file in millimetres?") instead of quietly building a 1000× too large box. `assumeUnits: "mm"`, an
  explicit domain, or a smaller model continues without asking.

Measured: sphere r5 with `domain {type:"external"}` and `targetCells 60000` → box −35…55 × ±35 mm,
47×37×37 background cells, snappy builds, gate PASS. A 40×20×20 mm box with `targetCells 16000` → 1.0 mm cells,
`cells [40,20,20]`.

## Shared core and passports

The gate, the `checkMesh` parser, config, paths, cards and the `mesh-handoff/1` writer live in `../sim-core`;
this plugin is a provider of the `simMesh` service (`build`/`check`/`deliver`/`patchTypes`/`hints`), a provider of
the `meshToolkit` service (`mesh`/`gate`/`deliver`/`patchTypes`) and a consumer of `simHints`.
The project profile is `sim-project.json` at the root (units, caseRoots, scratch, foam, gate, geometry, cores).
After a scaffold `case-manifest.json` is written, after the gate — `mesh-passport.json`:
route, cells, regions, gate, sha256/size/mtime of the polyMesh. `mesh_check` reports passport freshness
and any mismatch between the recorded verdict and the current one.

## Quality gate

`mesh_check` (and automatically after a successful `mesh_build` when `gate` ≠ false) calls the JS gate
`sim-core/lib/gate.js`: it writes the complete `meshQualityDict` (13 keys), builds the overlay
`<case>/.mesh-gate/<target>` and runs `checkMesh -meshQuality`. The verdict is computed **from the text**:
`checkMesh` returns 0 even on `Failed N mesh checks`. Result:
`{ verdict: PASS|FAIL|ERROR, failingRegions, results[{target, pass, failKind, metrics}] }`, where `metrics` are
`cells`, `maxNonOrtho`, `avgNonOrtho`, `maxSkewness`, `minVolume`, `violations`, layers
(`Added N out of M cells (P%)`). `minVol` is absolute: not set by the profile/call → `-1` is written into the
dictionary (check disabled) and the response carries `disabled-minVol-not-configured`; on failure — the advice
`minVol = minVolume/12`. `gate.engine: "script"` + `gate.script` is kept as an escape hatch to
`tools/qa/mesh_gate.sh`.

## Surface fidelity (`mesh_surface_check`)

Snappy may silently drop half of the geometry when `domainMin`/`domainMax` cut the STL — the gate still says PASS
because the mesh it kept is fine. This tool compares the meshed surface with the reference STL:

```js
mesh_surface_check({ caseDir: "cases/sphere", stl: ["stl/sphere.clean.stl"], tol: 0.05 })
// -> { verdict: "PASS", diffs: { bboxRel: 0.0002, areaRel: 0.002, volRel: 0.0002, hausdorffRel: 0.0005 }, faces: 1848 }
```

- The patch surface is exported from `constant/polyMesh/{points,faces,boundary}` in JS: `surfaceMeshTriangulate`
  exists only in OpenFOAM.org, and the pointer needs no OpenFOAM at all.
- Reference STL units come from `handoff.json` (`units.stl`, millimetres by default) and are converted to metres.
- **PASS = `bboxRel <= tol` and `hausdorffRel <= tol`.** Area and volume are diagnostics: a snapped voxel surface is
  stair-stepped, so a sphere legitimately has `areaRel ≈ 0.46` while its Hausdorff stays under 1 %.
- The Hausdorff is approximate — triangle centroids of one surface against the triangles of the other (uniform grid,
  expanding-ring queries, both directions), which is fast and catches clipping, not sub-micron ripples.
- A FAIL with `bboxRel > tol` means the domain clips the geometry: enlarge it (or use `domain: { type: "external" }`).

## First layer from y+ (`mesh_first_layer`)

Size the near wall before meshing, instead of guessing `nLayers`/`firstLayerThickness`:

```
mesh_first_layer({ uRef: 30, lRef: 5, nu: 1.5e-5, yPlusTarget: 1, caseDir: "cases/sphere" })
```

The calculator uses the flat-plate correlation `Cf = 0.026·Re^(-1/7)`, `u_τ = U·√(Cf/2)`, first layer
`y⁺·ν/u_τ`, boundary layer `δ = 0.37·L·Re^(-0.2)`, and covers `coverage·δ` with geometric growth. It returns the
dimensionless numbers, the absolute dimensions, the layer count and a `scaffoldOptions` block for `mesh_build`.

**Relative vs absolute:** the snappy scaffold writes `relativeSizes true`, so `layerThickness` is relative to the
near-wall cell. Pass `cellSize` (metres, after refinement) — or `caseDir`, and the tool reads it from
`handoff.json` or from `blockMeshDict` + `polyMesh/points` + the refinement levels. With an absolute thickness
snappy quietly removes every layer (`Extruding 0 out of N faces`), which is exactly what this tool prevents; it
warns when the relative final layer would fall below `minThickness 0.075`.

Inverse mode answers the other question — "this mesh has a 5 µm first layer, what y+ does that give?":

```
mesh_first_layer({ uRef: 30, lRef: 5, firstLayer: 5e-6 })
```

`mesh_revise`'s `yplus` category uses the same correlation (`lib/firstlayer.js`), so a hand calculation and the
automatic revision cannot disagree.

## Patch roles (`mesh_patch_types`)

A scaffolded snappy case gives two patches: the obstacle/box faces as `wall` and the outer domain box as
`symmetry` (`world`). A solver needs flow roles, and in a regional case `changeDictionary` does not work, so the
type is retyped in `constant/<region>/polyMesh/boundary` (AGENTS.md §13, exp-006/D-013). `mesh_patch_types` does
that edit: it rewrites only the `type` line of each named patch, keeps `<boundary>.bak`, returns the before/after
diff, and refuses what it cannot do safely — an unknown patch name (listing the available `name (type)`), one
patch in two roles, `empty`/`cyclic`/`cyclicAMI` as a target for a flow boundary (topological constraints),
`cyclic`/`wedge` without a neighbour patch or wedge geometry, a multi-region case without `region`, and splitting
one patch into inlet+outlet (that needs a face set: `topoSet` + `createPatch`, or named patches from the
geometry). Inlet and outlet end up as type `patch`, so the semantic role is stored in `handoff.json` and carried
forward by `mesh_check`. `recheck:true` re-runs the gate and reports `sameAsRecorded` — patch types change what a
solver reads, never the mesh metrics. After a retype the passport is stale: run `mesh_check` again before
`mesh_deliver`.

## Revision loop (`mesh_revise`)

A solver run sends back a `mesh-feedback/1` document (category, evidence, expected values). `mesh_revise`
does not guess: the reaction table is **data** in `data/advice.json` — every category has a ladder of ops and a
ceiling, and the tool applies the NEXT rung, counted from the `revision` entries already in `handoff.json`.

- `apply:false` (default) returns the plan: which op, why, and the parameters that would change.
- `apply:true` rebuilds with `mesh_build` (same STL, domain, levels and minVol from the handoff), re-runs
  `mesh_check`, and appends `{attempt, category, changes, verdict}` to `history[]`.
- `patch-roles` goes through `mesh_patch_types` (no rebuild). `stl-quality` stops and asks for `stl_check` +
  cleanup. `units` refuses without an explicit `scale`.
- After three consecutive `nonortho`/`skewness` failures the table switches the strategy once
  (snappy → cfmesh) instead of repeating parameters; at the ceiling the tool returns
  `{ok:false, escalated:true, options:[...]}` for the user to choose.

The `yplus` rung computes `firstLayer = yPlus·ν/uTau` (the same correlation as `compute_first_layer`), derives the
layer count from the target first layer and the local cell size, and lowers snappy's own `minVol` threshold to
`firstLayer³/6` — otherwise snappy removes every layer before the gate ever sees it (benchmark DEF-10).

## OpenFOAM versions

Installations are declared in `sim-project.json` (`foam.installations`, `foam.default`); the tools accept
`openfoam: "<id>"` or an absolute path to `etc/bashrc`. Without the argument the default installation is used.

| | OpenFOAM.com (v2412…v2606) | OpenFOAM.org (v14) |
|---|---|---|
| cfMesh (`cartesianMesh`, `pMesh`, …) | ✅ | ❌ |
| `surfaceFeatureExtract` | ✅ | stub |
| `surfaceFeatures` + `surfaceFeaturesDict` | ❌ | ✅ |
| `reconstructParMesh -mergeTol` | ✅ | ❌ |
| `locationsInMesh` (multi-region CHT) | ✅ | ❌ |
| `foamRun` / `foamMultiRun` | ❌ | ✅ |

The `snappy` route adapts itself (choice of the feature dictionary, the `-mergeTol` flag); `preflight` of the
`cfmesh` route refuses outright on org. Verified on a 10 mm cube: com2512/com2606 — `maxNonOrtho 9.7073°`,
org14 — `25.2146°` with the same 2584 cells (`experiments/exp-019_openfoam-version-matrix`).
Details and installation — `meshing/OPENFOAM_VERSIONS.md`.

## Delivery (`mesh_deliver`)

`mesh_deliver` calls `make_delivery.sh` and returns a short JSON instead of the log. The script is taken from
the project (`tools/deliver/make_delivery.sh`), and if it is missing — from the bundle (`scripts/deliver/`, plan 1.4);
the chosen source is visible in `scriptOrigin`:

- **OpenFOAM**: `openfoam_<name>/` with a real `constant/` (`polyMesh`, `triSurface`), `system/`, `0/`,
  the `<name>.foam` marker (opens in ParaView) and a `.tar.gz` archive.
- **ANSYS/Fluent**: `ansys_<name>/<name>.msh`, the `read_mesh.jou` journal, a `.zip` archive; for CHT — one `.msh`
  per region, the base goes to `constant/polyMesh_combined`.
- **Report**: `delivery_<name>.{json,md}` — cells/patches/volume, the `.msh` → OpenFOAM round-trip,
  interface adjacency, the gate verdict.

The script verifies everything by actually running it: `checkMesh` inside the packaged case, the `<a>_to_<b>` ↔
`<b>_to_<a>` interface by face count, the sum of region volumes against combined, the round-trip through
`fluentMeshToFoam`/`fluent3DMeshToFoam`, the strict gate per region and archive integrity.

Precondition — a fresh `mesh-passport.json`: without a passport the tool returns `passport-missing`,
with a modified polyMesh — `passport-stale`; `force: true` lifts the restriction (the delivery gate still
runs). Pass `minVol` explicitly — otherwise the script uses its own `1e-14` threshold, which is too large for pore
cells of 0.05–0.1 mm. Example:

```json
{"caseDir":"experiments/exp-018_snappy-parameter-study/cases/v13_best",
 "name":"cht_v13","minVol":1e-16,"outDir":"deliver"}
```

Result (verified): multi-region 575 757 cells, the interface matches, both regions PASS,
round-trip ok, 66.6 s; single-region FCC — 27 424 cells, 3.5 s.

## Portable mode (without `sim-project.json`)

The tools work in an empty directory: the response carries `project: "defaults"` and `configured: false`,
cases default to `./cases`, the gate profile is `project`, and `mesh_deliver` uses the bundled copy of
`scripts/deliver/make_delivery.sh` (the gate writes its overlay into `<outDir>/.gate`).
The end-to-end scenario STL → snappy → gate → delivery and the table of default values —
[`docs/PORTABLE.md`](docs/PORTABLE.md); card `mesh_hints({ id: "portable-mesh-build" })`.

## Knowledge cards (`data/hints/`)

`snappy.json` (10) — parameter traps; `cfmesh-gmsh.json` (4) — cartesianMesh/pMesh/layers over tetra/route D;
`quality.json` (7) — the gate, absolute minVol, delivery, polyhedra, ParaView, rejected routes, Fluent.

## Extending

- **A route**: an entry in `data/engine.json` (steps + `failures` with verbatim error strings). Removing the entry
  removes the route from the tool.
- **Knowledge**: a card in `data/hints/*.json` (see the format in mesh-stl/README).
- **The case template**: `lib/scaffold.js` (`writeSnappyCase`) — the only place where dictionaries are written;
  change it together with `node plugins/mesh-build/scripts/smoke.mjs`.
- After edits — smoke and a bundle reload: `plugin_manager set_plugin {target:"include:mesh-build",
  enabled:false}` → `enabled:true`. Changed ESM modules are unloaded on reload; no DSH restart is needed.

## Limits

- It does not build geometry (that is `mesh-stl`) and does not run solvers.
- Long runs go to the background: the tool returns control at the step's `timeoutMs`, the full log stays on disk.
- An existing case is not overwritten without `overwrite: true`; `mesh_check` does not change the mesh but writes `mesh-passport.json`.
