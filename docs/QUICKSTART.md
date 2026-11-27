# Quickstart

From nothing to a gated OpenFOAM mesh in five tool calls. Nothing below needs the `Mesh_3D_pore_scale` project:
the toolkit runs in any directory (portable mode), and only the third step needs OpenFOAM installed.

## 1. Install

Three ways in, all ending with the same `node_modules/mesh-toolkit`: a git install (below), a plugin market
(add the index URL from `market/index.json`), or the release tarball
`mesh-toolkit-<version>.tgz` — unpack it into `node_modules/mesh-toolkit` and the `scripts/` inside it run
`doctor` and `demo` without a checkout.

The repository root is a single package, so one line installs everything:

```bash
dsh plugin --profile <profile> add "git+https://github.com/AstDen/dsh-mesh-toolkit.git#<commit>"
```

`<commit>` is the full 40-hex pin in [`market/index.json`](../market/index.json) — the same commit the
plugin market installs. The three source trees ship inside the package, so the relative imports
between them work without any sibling layout.

**From a plugin market** (no shell): enable the experimental *Custom plugin indexes* bundle, add
`https://raw.githubusercontent.com/AstDen/dsh-mesh-toolkit/master/market/index.json` under
Plugins → Discover → Add index source, then install *Mesh toolkit*.

**From a checkout** (development): clone the repository and point `install_bundle` at
`<checkout>/mesh-stl` and `<checkout>/mesh-build`; keep the three directories as siblings.

## 2. Enable

The single-package install enables both plugin rows (`mesh-toolkit/stl`, `mesh-toolkit/build`) by itself.
With a checkout, enable each bundle (the installer adds a `link:` dependency and turns it on):

```json
{ "action": "install_bundle", "target": "/path/to/dsh-mesh-toolkit/mesh-stl" }
{ "action": "install_bundle", "target": "/path/to/dsh-mesh-toolkit/mesh-build" }
```

`sim-core` is a library, not a bundle — nothing to install for it. Afterwards the profile lists both packages
in its dependencies, and `plugin_manager list_plugins` shows them enabled. Restart DSH or toggle a bundle
(`set_plugin` `enabled: false` then `true`) so the modules load.

Before talking to the agent, check the machine from a checkout:

```bash
node scripts/doctor.mjs   # PASS/WARN/FAIL per area, with the fix for every WARN
node scripts/demo.mjs     # geometry -> STL QA -> mesh -> gate -> delivery, about 30 s
```

`demo` writes `.cache/demo/deliver/openfoam_demo/demo.foam`; open it in ParaView to see what the
pipeline produces before running it on your own geometry (README § 60 seconds has the pictures).

Confirm from the agent side — `mesh_hints()` with no arguments prints the card catalogue and the version block:

```
mesh_hints() -> versionInfo { reported: "1.0.0", onDisk: "1.0.0", stale: false }, 40 cards
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
node <repo>/scripts/contract-test.mjs             # 39/39 here: library + tools + OpenFOAM + workbench tiers
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

## 6. Tutorials as an oracle

The OpenFOAM tutorials are the cheapest independent check that a mesher did what it claims.
`mesh_tutorial` reads a tutorial `Allrun` as steps (no shell), replays it in a copy and writes a
manifest you can diff later:

```
mesh_tutorial({ action: "list" })                                  // 51 cases on v2606, 9 on org14
mesh_tutorial({ action: "run", case: "snappyHexMesh/flange",
                out: "cases/tut-flange", steps: "mesh-only", np: 1 })
mesh_tutorial({ action: "compare", manifest: "cases/tut-flange/tutorial-manifest.json",
                baseline: "experiments/exp-025_tutorial-2606/cases/tut-01_flange/tutorial-manifest.json" })
```

Measured on v2606: `flange` → PASS, 19 186 cells, `maxNonOrtho 50.9531`; `sphere_multiRegion` → 8 000 / 0;
`block_with_curvature` → 9 413 / 25.2394. A `compare` that reports `cellsDelta 0` across com2512 and
com2606 means the dictionaries were understood the same way by both builds.

Outside the project there is no `sim-project.json`, so pass the bashrc explicitly — set `MESH_OPENFOAM_BASHRC`
or give an absolute path (`--build /abs/etc/bashrc`); a plain id such as `--build com2606` only resolves where
`foam.installations` is declared. `steps: "mesh-only"` skips solvers; `keepGoing: true` keeps replaying after a step that a tutorial makes
fail on purpose (`motorBike_leakDetection`). What does not reproduce: `foamyHexMesh/flange` and
`simpleShapes` (SIGFPE inside the mesher) and `distributedTriSurfaceMesh` (needs more RAM than 31 GiB).

## Where to go next

| need | doc |
|---|---|
| an error string you do not recognise | [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) |
| configuration keys (`foam`, `caseRoots`, `gate`, `generators`, `qa`) | README § Configuration |
| running without this research project | [`PORTABLE.md`](PORTABLE.md) |
| changing the packages, releases, CI | [`PACKAGING.md`](PACKAGING.md) |
| which route to mesh with, and what it costs | `mesh_hints()` cards, or [`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md) §5 |
| replaying an OpenFOAM tutorial | `mesh_tutorial` above, and [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) § Tutorials |
