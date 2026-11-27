# Troubleshooting

Every string below is **literal** — either emitted by this toolkit (grepped from the sources) or produced by
OpenFOAM and observed on this project's runs. Find your line, apply the fix, and if the line is missing here, the
answer is probably in `mesh_hints(<the failing metric>)`.

Status marks follow the project convention: ✅ observed with a real run · 🟡 deduced from the code/documentation.

## Setup and loading

| String | Cause | Fix |
|---|---|---|
| `service "meshToolkit" has been registered at <mesh-stl>` | both bundles are enabled and one of them predates 1.0.1, so each tried to register the shared service | update to **1.0.1 or newer** (`dsh plugin --profile <p> add "git+…#v1.0.1"`), then restart the plugin graph; the service is now single-instance per app |
| `meshToolkit.<method> is not provided by any installed package` / `"error": "not-provided"` | a consumer asked the `meshToolkit` service for a method the installed version does not have | upgrade the package that ships the method; `ensureToolkit` never throws |
| `versionInfo { reported: "0.7.2", onDisk: "0.7.5", stale: true }` ✅ | the live process still runs older modules: a version-only bump does not evict the ESM cache | toggle the plugin off/on, and if the changed module is `sim-core`, restart DSH |
| `error: 'OpenFOAM is not configured: no bashrc detected'` | no `foam` block in the profile and no installation in the default locations | `mesh_capabilities()` shows what was found; set `foam.installations` + `foam.default` |
| `error: 'python-bridge-missing'` 🟡 | a python-backed generator family was requested without python + numpy in the configured interpreter | `generators.python` in the config, or use a JS family (`primitive`, `box-array`, `stratified-channel`) |
| `QA ERROR: ImportError: no graph engines available!` ✅ | the python reference QA cannot import trimesh/networkx in the venv | install the extras, or set `qa.engine: "js"` (the in-process reader needs no python) |
| `mesh-build/plugin.json[5]: evidence must be a non-empty array` ✅ | catalogue check: a knowledge card's `evidence` was a string instead of a list | wrap it in a list — this fires in CI before publishing |

## STL

| String | Cause | Fix |
|---|---|---|
| `STL not found: <path>` / `reference STL not found: <path>` | a relative path resolved against the wrong root (the project root, not your shell cwd) | use absolute paths, or set `caseRoots`/the project root to the directory you mean |
| `binary STL is truncated: declares N triangles (X bytes), file has Y` 🟡 | a partially written or git-lfs stubbed file | re-export, then `stl_check` must return `verdict: "PASS"` |
| `binary polyMesh is not supported (writeFormat ascii)` | the case was written in binary and the JS readers (`mesh_surface_check`, `mesh_patch_types`) parse ASCII | run `foamFormatConvert -case <case>` (it rewrites binary → ASCII in place), or set `writeFormat ascii;` in `system/controlDict` and re-run the mesher |
| `STL is NOT watertight (even after removing degenerate faces)` ✅ / `raw STL is not watertight (degenerate faces: N, non-manifold edges: M): ...` ✅ | a CAD STL with degenerate faces at seams/poles, or a surface that was never closed | `stl_check({ stl, cleanup: true })` and mesh the cleaned file; a non-manifold edge cannot be fixed by merging vertices — regenerate the geometry |
| `non-manifold: N edges with >2 faces (zero-thickness surface contact: ...)` ✅ | two closed shells touch along an edge — watertight per shell, ambiguous for the mesher | regenerate with a gap; `mesh-stl` card `stl-cleanup` explains the cleanup limit |
| `expected an STL file, got a directory: <path>` | `stl` got a directory | pass the `.stl` file, or the family/preset to generate it |

## Meshing

| String | Cause | Fix |
|---|---|---|
| `FOAM FATAL ERROR: Point (x y z) is not inside the mesh or on a face or edge.` ✅ | `locationInMesh` outside the background block, or in mm while the case is in metres | points are in **metres** in the case; `.cache`-style helper `plugins/mesh-build/scripts/fluid-point.py` computes one inside the fluid |
| `error: locationInMesh for "fluid" is outside the domain: (0.001 0.001 0.001)` ✅ | the same, caught before snappy starts | fix the point or the domain; the answer names the domain it used |
| `locationInMesh not given: picked (x y z) mm, N mm from the nearest wall` 🟡 | not an error: the scaffold found the fluid point itself (D-8) | keep it, or pass your own `locationInMesh`; `autoFluidPoint: false` turns the automatic pick off |
| `no point at least 0.1 mm from every wall and inside the domain` ✅ | the clearance is larger than the free space, or the STL is not a closed fluid region | lower `autoFluidClearanceMm`, check the STL with `stl_check`, or pass an explicit `locationInMesh` |
| `nCellsBetweenLevels must be an integer 1..10 (got 2.5)` ✅ | the value is not an integer in range | pass 1..10; 2 halves the cell jump between refinement levels, 4 is the snappy default |
| `refinementRegions[0] (box) does not intersect the domain …` ✅ | the region is outside the background block, so it would refine nothing | grow the domain or move the region inside it — the message prints both boxes |
| `FAIL … layer coverage 83.2% < 90% (Extruding 7990 out of 9600 faces)` ✅ | `minLayerCoverage` in the gate profile is above what the layers actually covered | refine the surface, lower `nLayers`/`expansionRatio`, or relax `minLayerCoverage` for this geometry |
| `minVolSource: "derived-then-measured"` 🟡 | no error: the derived `h_min³/6` flagged healthy boundary cells and the check was re-run at the measured value | pass `minVol` explicitly if the profile threshold is authoritative for this case |
| `FOAM FATAL IO ERROR: Entry 'solver' not found in dictionary ".../snapControls"` ✅ | `addLayers` type `castellatedBufferLayer` needs `_meshMotionSolver` with a `solver` entry | either add `displacementPointSmoothing` + `pointSmoother laplacian` (and `${_meshMotionSolver}` in `snapControls`), or use the plain `addLayers` path |
| `clamped: true` in a `mesh_first_layer` answer 🟡 | the y+ target needs a first cell taller than half the near-wall cell, which snappy cannot extrude | the answer reports the y+ actually obtained (`yPlusFirst`); refine the surface (`targetCells`, a higher level) or raise `yPlusTarget` — do not force the thickness |
| `formula.cfModel: "laminar-blasius"` 🟡 | not an error: Re < 5e5, so the laminar Blasius correlation was used instead of the turbulent 1/7-power law (D-5) | if the case really is turbulent, check `uRef`/`lRef`/`nu`; `legacyYPlus: true` restores the pre-1.3 numbers for comparison only |
| layer counts halved after upgrading to 1.3.0 🟡 | expected: the first cell is now twice the y+ wall distance (y+ is a centroid quantity) | compare with `legacyYPlus: true`; do not halve the thickness by hand |
| `Extruding 0 out of 9600 faces (0%)` ✅ | `finalLayerThickness` given in **metres** while the case writes `relativeSizes true` | with `relativeSizes true` the thicknesses are **relative** (`lastLayer / cellSize`); `mesh_first_layer` returns the right block |
| layers grow 0 faces and nothing else complains ✅ | `minVol` in `snappyHexMeshDict` too large: cells are marked illegal, so no layer is extruded | `minVol ≈ h_min³/6`; `mesh_revise`/`mesh_first_layer` set it with the first layer's volume in mind |
| `Finished meshing with N illegal faces` in the snappy log while the gate says PASS ✅ | the gate re-ran `checkMesh` at a *measured* `minVol` (`derived-then-measured`) and that threshold hid the illegal cells the mesher itself reported | treat a non-zero snappy illegal-face count as a FAIL for the case: fix the domain/refinement (a clipped STL is the usual cause) and rebuild; do not rely on the gate alone here |
| no `outlet` patch after meshing, the whole outlet plane is inside `world` ✅ | the outlet surface lies exactly on `domainMax`, so snappy assigns the boundary plane to the background patch instead of re-patching it | extend the domain past the physical outlet (one or two background cells), or cut the patch out of `world` with `createPatch`/`topoSet` |
| `solvers { }` and `SIMPLE { }` in `system/fvSolution`, `application snappyHexMesh` in `controlDict` 🟡 | `mesh_build` writes a *placeholder* system skeleton, just enough for `checkMesh`/the gate — it is not a solver setup | run the workbench's `openfoam_case_scaffold({ casePath, force: true, U, nu, endTime })` before solving, or write the dictionaries yourself |
| `FOAM FATAL ERROR: unrecognised 3-D cell shape: 7` ✅ | `fluentMeshToFoam` reading a polyhedral `.msh` (only `fluent3DMeshToFoam` handles it) | use `fluent3DMeshToFoam`, or `mesh_deliver`'s round-trip which already does |
| `bash: surfaceMeshTriangulate: command not found` ✅ | that utility is OpenFOAM.org-only; com builds ship no triangulator | `mesh_surface_check` exports the surface from `polyMesh` in JS — no utility needed |
| `error: 'blockMeshDict or polyMesh/points not found — pass cellSize explicitly'` | `mesh_build` asked for a cell size it could not infer | pass `scaffoldOptions.cellSize` (m) or `targetCells` |
| `error: 'unknown family: <id>'` | typo in `stl_generate({ family })` | `stl_generate({})` with no family lists the nine families and their presets |

## Tutorials (`mesh_tutorial`)

| String | Cause | Fix |
|---|---|---|
| `FOAM FATAL ERROR: Locations in mesh 1((...)) connect to one of the locations outside mesh 1((...))` ✅ | a tutorial that fails on purpose: `motorBike_leakDetection` reports the leak on the first pass and closes it on the second | run it with `keepGoing: true`; the failed step lands in `failedSteps` and the gate judges the final mesh |
| `SIGFPE` with `conformalVoronoiMesh::dualCellLargestSurfaceProtrusion` in `03_foamyHexMesh.log` ✅ | known crash inside `foamyHexMesh` on v2606 for `foamyHexMesh/flange` and `simpleShapes`; `timedOut` is `false`, so it is not the runner | not fixable from the plugin: the cases are marked non-reproducible; do not disable `FOAM_SIGFPE` for a reproduced number |
| `list` shows a case with `manual: N` steps ✅ | the `Allrun` uses shell outside the interpreted subset (loops, `if`, `wmake`, `canCompile`) | the runner names the steps instead of guessing; replay the case by hand or pick another one |
| `unknown OpenFOAM installation "com2606"; available: (none declared in sim-project.json)` ✅ | outside a project there are no `foam.installations`, so an id cannot resolve | set `MESH_OPENFOAM_BASHRC` (or pass an absolute bashrc path) instead of an id |
| `decomposeParDict has 8 subdomains but np 4` | `np` was passed that does not match the case | omit `np` (the runner reads `decomposeParDict`) or pass the matching number; a sequential plan ignores `np` by design |
| `There are not enough slots available in the system to satisfy the 8 slots` ✅ | `decomposeParDict` asks for more subdomains than there are cores | the runner probes `mpirun --version` and adds `--oversubscribe`, as OpenFOAM's `RunFunctions` does; if you still see it, the MPI build was not detected |
| gate says "no mesh" on a foamy case, `constant/polyMesh` is empty ✅ | `foamyHexMesh` writes into time directories (`80` → `81` → `82`), and the tutorial's own `checkMesh -latestTime` reads the last one | `mesh_tutorial` promotes the last time directory into `constant/polyMesh` and records `meshFromTimeDir` in the manifest, so the substitution is visible |
| `0/nonOrthoAngle` appeared in the case after `mesh_check({writeFields})` ✅ | `checkMesh -writeFields` writes into the `-case` it is pointed at; the gate overlay used to symlink `0/` | fixed: the overlay copies `0/` when `writeFields` is requested; update if you still see the field in the real case |

## Quality gate

| String | Cause | Fix |
|---|---|---|
| `checkMesh` exits **0** but the log says `Failed 5 mesh checks` ✅ | `checkMesh` returns 0 on quality failures; the verdict must be read from the text | trust `mesh_check` (it parses the log), never the exit code |
| `FOAM FATAL ERROR: cannot find file ".../.mesh-gate/base/system/fvSchemes"` ✅ | the gate overlay ran `checkMesh -meshQuality` in a directory without the case dictionaries | fixed by `ensureGateDicts` (shipped with the benchmark fixes); update if you still see it |
| gate `FAIL minVol-threshold: N faces < X` ✅ | `minVol` 100–1000× too strict for the cell size | `minVol ≈ h_min³ / 6`; `mesh_check` suggests `minVolume/12` when it can |
| `disabled-minVol-not-configured` in the gate answer | no `minVol` in the profile, none passed, and nothing derivable: no handoff `selection.cellSize_m` and no `system/meshQualityDict` | pass `minVol` per mesh — the check is skipped otherwise, not silently passed |
| `minVolSource: "derived-then-tightened"` + `minVol … flagged healthy boundary cells` ✅ | `h_min³/6` is the rule for the *intended* cell, but snappy legitimately extrudes thinner boundary cells, so the derived threshold tripped the volume check | nothing to fix: the gate re-ran once at the measured suggestion (`minVolume/12`) and the verdict comes from that run; pass `minVol` to pin a threshold |
| `FAIL … layer coverage 10% < 80% (Extruding 100 out of 1000 faces)` ✅ | `minLayerCoverage` from the profile is now enforced on the *faces* line of the snappy log (D-10) | grow the layers (`mesh_revise` with a `layers` feedback, or `nLayers`/`layerThickness`), or lower `minLayerCoverage` for a deliberately coarse check |
| `layers.status: "no-faces"` | the case has no snappy log with `Extruding … faces` (no layers requested, or a non-snappy route) | expected: there is nothing to measure; request layers or accept the cell-count view |
| `error: 'passport-missing'` / `'passport-not-pass'` / `'passport-stale'` | `mesh_deliver` requires a passport that matches the mesh on disk | run `mesh_check` after the last rebuild (the passport records the mesh hash) |
| `patch not found: nope; the case has world, a1-cube` ✅ | `mesh_patch_types` got a patch name that is not in `constant/polyMesh/boundary` | the answer lists the real names; watch for STL-stem names like `a1-cube` |

## Delivery and the workbench seam

| String | Cause | Fix |
|---|---|---|
| `Cannot find patchField entry for a1-cube` ✅ `--> FOAM FATAL IO ERROR: (openfoam-2512)` | an `0/U` written with **wrong patch names** — measured with `@yakovlev-i-a/dsh-openfoam-workbench` 0.9.22, whose `parseBoundaryPatches` truncates hyphenated names (`a1-cube` → `cube`) | until they fix it: no hyphens in STL names/surfaces (use `a1_cube`), or pass `patches` explicitly to their `openfoam_case_scaffold` |
| `known-gap [workbench] M3c ...` in `scripts/contract-test.mjs` | the workbench tier found the defect above; it is reported, not failed, because the fix lives in their repository | `CONTRACT_TEST_REQUIRE_WORKBENCH=1` turns it into a hard failure once they ship the fix |
| `SKIP [openfoam] fixture missing: …/a1-cube.stl` | the OpenFOAM tier wants one closed STL | `CONTRACT_TEST_STL=/path/to/closed.stl` |
| `SKIP [workbench] dsh-openfoam-workbench not installed — set CONTRACT_TEST_WORKBENCH=<package dir> to include this tier` | that plugin is not in any profile | `CONTRACT_TEST_WORKBENCH=/path/to/dsh-openfoam-workbench` |

## ANSYS Fluent (`mesh_deliver` output)

| String | Cause | Fix |
|---|---|---|
| `Cannot initialize ANSYS Licensing context` ✅ | Fluent started inside the agent's workspace sandbox: the licensing library needs paths it cannot reach there | run the session with full access (no sandbox) and `ANSYSLMD_LICENSE_FILE=1055@192.168.1.100` from the project `~/.bashrc` |
| `Unexpected license problem; exiting.` ✅ + `basic_string::replace: __pos ... > this->size()` | same cause as above — the cryptic `std::out_of_range` is the licensing context failing, not the `.msh` | as above; the mesh itself reads fine afterwards (`148288 mixed cells`, `check mesh` → `Done.`) |
| `Reading "demo.msh"... 148288 mixed cells, zone 1` ✅ then `Minimum Orthogonal Quality = 3.88782e-01` | normal: `foamMeshToFluent` writes polyhedra as `mixed` cells and Fluent accepts them | nothing to fix; Fluent's orthogonal quality is a different functional from our `maxNonOrtho` (26.41° here), so do not compare the numbers directly |

## Reload and cache traps

- A **version-only** change never reloads: the module graph is evicted per *content* change. Append a comment, toggle
  the plugin, then revert.
- Modules imported by `sim-core` from `mesh-build` stay cached across a toggle; a `sim-core` change needs a DSH
  restart.
- `processor*/` (parallel decomposition) and log files survive a failed run — delete them by hand
  (`rm -rf processor* logs/*.log`) and keep `0/`, `constant/`, `system/`; there is no `mesh_clean` tool, and
  re-running `mesh_build` with `overwrite: true` rebuilds the mesh step only.
