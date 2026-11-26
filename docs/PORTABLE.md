# Portable mode: working without `sim-project.json`

The **mesh-stl** and **mesh-build** plugins work in an empty directory. The project profile
(`sim-project.json`) is no longer mandatory: it is needed only where you want to pin down
your own paths, units, gate thresholds and OpenFOAM installations.

## What is enabled automatically

| Item | Default without a profile | How to override |
|---|---|---|
| Project root | current directory (`process.cwd()`) | `sim-project.json`, `projectRoot` in the config, `MESH_*_PROJECT_ROOT` |
| Label in the response | `project: "defaults"`, `configured: false` | `sim-project.json` → `project: "<name>"` |
| STL units | mm | `sim-project.json` → `units` |
| STL registry | `./stl/registry.csv` (the header is created on the first write) | `geometry.registry`, `MESH_STL_REGISTRY` |
| Generator output | `./stl/generated/<family>/` | `geometry.workRoot`, `workRoot` |
| Meshing cases | `./cases/` | `caseRoots` |
| Gate profile | `project` (nonOrtho 60, skewness 4/2, minVolRatio 0.05) | `gate.profile`, `gate.profiles` |
| `minVol` threshold | not set → the check is disabled and `advisory` says so | `gate.minVol` or the `minVol` argument (absolute, `h_min³/6`) |
| Delivery script | the packaged `scripts/deliver/make_delivery.sh` inside the bundle | `tools/deliver/make_delivery.sh` in the project takes precedence |
| Delivery gate cache | `<outDir>/.gate` (via `MESH_GATE_CACHE_DIR`) | the same environment variable |

## End-to-end scenario (verified 2026-11-26)

```bash
mkdir my-case && cd my-case

# 1. Geometry (JS, no python)
stl_generate({ family: "primitive", name: "cube", params: { size_mm: [10, 10, 10] } })
#   → ./stl/generated/primitive/cube.stl, QA PASS, project: "defaults"

# 2. STL contract
stl_check({ stl: "stl/generated/primitive/cube.stl", expectVolume: 1000, expectArea: 600, expectBodies: 1 })
#   → verdict PASS, qa.engine "js"

# 3. Mesh
mesh_build({ route: "snappy", scaffold: true, caseDir: "cases/cube",
             stl: ["stl/generated/primitive/cube.stl"],
             openfoam: "/usr/lib/openfoam/openfoam2512/etc/bashrc",
             scaffoldOptions: { domainMin: [-0.002,-0.002,-0.002], domainMax: [0.012,0.012,0.012],
                                cells: [16,16,16], locationInMesh: [0.001,0.001,0.001], minVol: 1e-12 } })
#   → blockMesh → surfaceFeatureExtract → snappyHexMesh

# 4. Gate
mesh_check({ caseDir: "cases/cube", minVol: 1e-12, profile: "project" })
#   → gate.verdict PASS, passport fresh

# 5. Delivery
mesh_deliver({ caseDir: "cases/cube", name: "cube", minVol: 1e-12 })
#   → DELIVERED: openfoam_cube/ + .tar.gz + ansys_cube/ + .zip + delivery_cube.{json,md}
```

Reference numbers for this run: 12 triangles, volume 1000 mm³, 2584 cells,
`gate.verdict PASS` (maxNonOrtho 18.29°, skewness 0.2997), `DELIVERED`, 1.8 MB of artefacts.

## Where a profile is still required

- **OpenFOAM installations.** Without a profile the `foam.installations` list is empty: pass
  `openfoam: "/path/to/etc/bashrc"` to `mesh_build` / `mesh_check` / `mesh_deliver`
  (or create `sim-project.json` — the ids `com2512`/`com2606`/`org14` live there too).
- **Custom gate thresholds.** `gate.profiles` (for example, relaxing `maxNonOrtho` to 75) come only from a profile.
- **Units other than mm.** Set `units` explicitly in the profile; otherwise everything is treated as millimetres.
- **Multi-region CHT** — `caseRoots` and per-region delivery are described in the profile, but
  `mesh_deliver --regions/--multi-region` works without one as well.

## Diagnostics

- `project: "defaults"` and a `next` hint saying "working without sim-project.json" are normal,
  not an error: the tool reports which defaults it applied.
- A read-only registry is not an error: `registered: {ok: false, error, row}`, and the verdict is preserved.
- No `world` patch after snappy — `phase: "sanity"`: `locationInMesh` landed inside a closed
  solid body; `mesh-build/scripts/fluid-point.py` picks a point that works.
