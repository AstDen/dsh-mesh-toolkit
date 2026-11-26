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

## Shared core and passports

The gate, the `checkMesh` parser, config, paths and cards live in `../sim-core` (package `sim-core`, 0.3.0);
this plugin is a provider of the `simMesh` service (`build`/`check`/`hints`) and a consumer of `simHints`.
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
