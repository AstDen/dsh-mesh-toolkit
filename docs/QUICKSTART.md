# Quickstart

From nothing to a gated OpenFOAM mesh in five tool calls. Nothing below needs the `Mesh_3D_pore_scale` project:
the toolkit runs in any directory (portable mode), and only the third step needs OpenFOAM installed.

## 1. Install

**From git** (recommended; you get the tags and the docs):

```bash
git clone git@github.com:AstDen/dsh-mesh-toolkit.git ~/dsh-mesh-toolkit
cd ~/dsh-mesh-toolkit && git checkout v0.7.5
```

**From the release tarballs** — unpack the three packages into the profile's `node_modules`:

```bash
tar -xzf mesh-build-0.7.5.tgz   && mv package mesh-build
tar -xzf mesh-stl-0.4.1.tgz     && mv package mesh-stl
tar -xzf sim-core-0.5.1.tgz     && mv package sim-core
mv mesh-build mesh-stl sim-core ~/.dsh/profiles/<profile>/node_modules/
```

Either way the three packages must sit **side by side** in `node_modules`: `mesh-build` imports
`../sim-core/lib/...` relatively, and a package manager that nests them breaks that import.

## 2. Enable

Enable both bundles (the installer adds a `link:` dependency to the profile and turns the bundle on):

```json
{ "action": "install_bundle", "target": "/path/to/dsh-mesh-toolkit/mesh-stl" }
{ "action": "install_bundle", "target": "/path/to/dsh-mesh-toolkit/mesh-build" }
```

`sim-core` is a library, not a bundle — nothing to install for it. Afterwards the profile lists both packages
in its dependencies, and `plugin_manager list_plugins` shows them enabled. Restart DSH or toggle a bundle
(`set_plugin` `enabled: false` then `true`) so the modules load.

Confirm from the agent side — `mesh_hints()` with no arguments prints the card catalogue and the version block:

```
mesh_hints() -> versionInfo { reported: "0.7.5", onDisk: "0.7.5", stale: false }, 40 cards
```

`stale: true` means the live process runs older code than the files on disk: toggle the bundle, and restart DSH
if the changed module lives in `sim-core`. A version-only change (a `package.json` bump) does **not** reload.

OpenFOAM is discovered from the usual locations, or named explicitly in `sim-project.json`:

```json
{ "foam": { "installations": { "com2512": "/usr/lib/openfoam/openfoam2512/etc/bashrc" }, "default": "com2512" } }
```

`mesh_capabilities()` then reports what that build actually accepts (cfMesh present? `scale` or `convertToMeters`?
`minMedialAxisAngle` or `minMedianAxisAngle`?).

## 3. Geometry → mesh → gate → delivery

Work in an empty directory (or one with a `sim-project.json`). Generator output lands in
`<geometry.workRoot>/<family>/<name>.stl`; without a project file `workRoot` defaults to `.cache/sim`.

The sequence below was run end to end on 2026-11-26 with the `primitive` family (a 10 mm cube, the default
preset, generated with an explicit `outDir`; the paths shown are the portable defaults) — every tool returned
the numbers quoted after the block:

```
stl_generate({ family: "primitive", name: "cube" })      # 1. 12 triangles, volume 1000 mm³, QA PASS
stl_check({ stl: ".cache/sim/primitive/cube.stl" })      # 2. contract: watertight, winding, volume, bodies
mesh_build({                                             # 3. scaffold + blockMesh + snappy + gate
  route: "snappy",
  stl: [".cache/sim/primitive/cube.stl"], caseDir: "cases/cube", scaffold: true,
  scaffoldOptions: { domain: { type: "external" }, targetCells: 40000,
                     refinementLevels: { cube: 1 }, locationInMesh: [-0.015, 0, 0] } })
mesh_check({ caseDir: "cases/cube", minVol: 1e-10 })     # 4. verdict + handoff.json
mesh_deliver({ caseDir: "cases/cube", name: "qs-cube", minVol: 1e-10 })   # 5. case + .msh + reports
```

Measured on that run: background `41×32×32`, **45 053 cells**, gate **PASS** (`maxNonOrtho 20.03°`,
`maxSkewness 0.608`, `minVolume 9.81e-10 m³`), delivery **DELIVERED** with a `fluent3DMeshToFoam` round-trip
(45 053 cells, same volume 4.4001e-4 m³) and a 1.5 MB `.tar.gz`.

Notes that save a round trip:

- **`route` is required.** `mesh_build` without a route returns the route catalogue instead of meshing.
- `scaffoldOptions.domain.type`: `external` for flow around a body (default margins 3 upstream, 5 downstream,
  3 lateral, in units of the largest extent), `internal` for a cavity whose domain is the STL bounding box,
  `wrap` for a padded box. `targetCells` is a budget, not a promise — it picks the background cell size.
- **`locationInMesh` is in metres** (the case is in metres, the STL stays millimetres with `scale 0.001`).
  Pick a point upstream of the body but inside the domain: `[-0.015, 0, 0]` for a cube spanning ±5 mm inside a
  domain `-35…55 mm`. For a random packing or a pore geometry, derive the point from the STL instead of guessing:

  ```bash
  python3 <repo>/mesh-build/scripts/fluid-point.py .cache/sim/packing/box.stl --clearance 0.1
  # {"ok": true, "point_mm": [x, y, z], "clearance_mm": 0.21, ...}   -> divide by 1000 for metres
  ```

- `minVol` for `mesh_check`/`mesh_deliver` is an **absolute** volume in m³, not a fraction of a cell. Rule of
  thumb: `h_min³ / 6` (2.2 mm cells → ~1e-9; pass `1e-10` to stay safe). Without it the check is disabled with
  an advisory — see TROUBLESHOOTING, "Extruding 0 out of …".

## 4. Check it works

```bash
node <repo>/scripts/contract-test.mjs             # 37/37 here: library + tools + OpenFOAM + workbench tiers
node <repo>/scripts/contract-test.mjs --no-mesh   # library only, no OpenFOAM needed
```

Each tier prints `SKIP <reason>` when its prerequisites are missing, so a laptop run is a valid result too.

## 5. Hand over to a case builder

The delivered case carries `handoff.json`; an OpenFOAM case builder reads `patches[].role`
(`inlet`/`outlet`/`wall`/`symmetry`/`interface`) instead of guessing from names. If the roles need changing after
the mesh exists, `mesh_patch_types` retypes `constant/polyMesh/boundary` with a `.bak` and re-runs the gate to show
that the metrics did not move:

```
mesh_patch_types({ caseDir: "cases/fcc", roles: { walls: ["fcc-cell"], symmetry: ["world"] }, recheck: true })
```

The full two-sided contract is [`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md); the author-side checklist is
Part B of [`PLAN-workbench-integration.md`](PLAN-workbench-integration.md).

## Where to go next

| need | doc |
|---|---|
| an error string you do not recognise | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) |
| configuration keys (`foam`, `caseRoots`, `gate`, `generators`, `qa`) | README § Configuration |
| running without this research project | [`PORTABLE.md`](PORTABLE.md) |
| changing the packages, releases, CI | [`PACKAGING.md`](PACKAGING.md) |
| which route to mesh with, and what it costs | `mesh_hints()` cards, or [`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md) §5 |
