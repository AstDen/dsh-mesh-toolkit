# 0.7.5 — surface fidelity, capability matrix, contract acceptance suite

Packages: **mesh-build 0.7.5** · **mesh-stl 0.4.1** · **sim-core 0.5.1**

This release bundles the last three steps of the workbench contract (A7, A8, A9). It closes blocker 3 of
[`PLAN-release-1.0.md`](PLAN-release-1.0.md): the toolkit can now hand a mesh to a case builder through a
file contract, and the handshake is verified by a test suite that runs here and in CI.

## New tool: `mesh_surface_check` (0.7.3)

Fidelity of the built surface against the reference STL — catches a domain that clips the geometry.

- The patch faces are exported **straight from `constant/polyMesh` in JS**, so the check needs neither OpenFOAM
  nor a version-specific utility (OpenFOAM.com does not ship `surfaceMeshTriangulate`).
- Compares bounding box, area, volume and an approximate Hausdorff distance (triangle-centroid sampling both ways).
- PASS = `bboxRel <= tol` **and** `hausdorffRel <= tol`; area and volume stay diagnostics, because a snapped
  voxel surface is legitimately stair-stepped and carries more area than the smooth STL.
- Measured: a cube inside the domain `bboxRel 0`, `areaRel 0.0024`, `hausdorff 9.03 µm` → PASS; a sphere r 5 mm
  `hausdorffRel 0.0074` → PASS with `areaRel 0.463`; the benchmark's clipped E1 case `bboxRel 0.407`,
  `hausdorff 3.7 mm` → FAIL with the advice to enlarge `domainMin`/`domainMax`.

## New tool: `mesh_capabilities` (0.7.4)

What the installed OpenFOAM actually accepts, instead of a version table.

- Probes the executables (cfMesh/pMesh/tetMesh are OpenCFD-only, `surfaceFeatures` is Foundation-only) **and**
  `$WM_PROJECT_DIR/etc/caseDicts/annotated/*` for the dictionary keys of this exact build.
- Reports `distribution`, `version`, `commands`, `features` (`cfmesh`, `pmesh`, `gmsh`, `featuresNew`,
  `mergeTol`, `multiRegion`, …) and `dictKeys`: `blockMeshUnits` (`scale` vs `convertToMeters`),
  `featuresDict` (`surfaceFeaturesDict` vs `surfaceFeatureExtractDict`), `layerAxis`
  (`minMedialAxisAngle` vs `minMedianAxisAngle`), `locationsInMesh`, `castellatedBufferLayer`, `relativeSizes`.
- The scaffold now follows `dictKeys`, so the obsolete `convertToMeters` warning is gone and layer extrusion is
  spelled the way the installed build reads it. `mesh_build` returns the same block as `caps`.

## New in the repository: `scripts/contract-test.mjs` (0.7.5)

The acceptance suite from [`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md) §7, in three tiers that print
`SKIP <reason>` instead of failing:

| tier | runs when | covers |
|---|---|---|
| library | always | `meshToolkit` service, `mesh-handoff/1` validation, role aliases and refusals, the advice table (y+, escalation, route downgrade), unit suspicion |
| tools | the packages are importable | T4 — an ambiguous/millimetre-scale STL asks for units instead of clipping, then proceeds with `assumeUnits` |
| OpenFOAM | a bashrc resolves | T1 mesh → gate → handoff, T5 roles with unchanged metrics, T6 a broken partial mesh is rebuilt, T2 y+ feedback → revise → rebuild with history |

Measured here: **33/33** with all tiers, **28/28** with `--no-mesh`. CI runs the library tier on node 20 and 24;
the OpenFOAM tier needs one closed STL fixture (`CONTRACT_TEST_STL`) and a bashrc (`CONTRACT_TEST_BASHRC`).

`ROLE_ALIASES` and `normalizeRoles` are exported from `mesh-build`: the handoff's `next[]` hands plural role keys
to a consumer, so the mapping is public API.

## Upgrading

```bash
git -C <repo> pull && git -C <repo> checkout v0.7.5
# or the tarballs attached below, unpacked over ~/.dsh/profiles/<profile>/node_modules/
```

The live host must be reloaded after upgrading (toggle the plugin, or restart DSH): a version-only change does not
evict the cached modules.

## Verified

- `node scripts/contract-test.mjs` → 33/33 (library + tools + OpenFOAM tiers).
- `node scripts/check-catalogue.mjs` → 40 cards; `node scripts/check-versions.mjs` → versions OK.
- Both smoke scripts in portable mode; CI green on the tag commit.
