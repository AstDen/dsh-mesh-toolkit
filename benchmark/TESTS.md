# Mesh toolkit test suite — universal protocol

Version 1.0 · 2026-11-25 · covers `mesh-stl` 0.3.0, `mesh-build` 0.5.0, `sim-core` 0.4.0

This file is both a **test catalogue** (what to run and what "correct" means) and a **protocol**
(what to record, how to judge, what to hand back). It is written so that any agent — or a person
with the same plugins installed — can execute it without reading the plugin sources.

The suite answers one question: *can the two plugins carry a real meshing workflow end to end,
including their hints and their quality gate, without a human fixing their output?*

---

## 0. How to use this file

1. Read §1–§4 once. They define the rules, the environment and the conventions.
2. Execute the groups in the order of §16. For every case copy the record template from §15.3.
3. Fill `metrics.json` and `calls.csv` as you go — not from memory afterwards.
4. Judge with §15.5. A case that "built something" is not a pass: the gate verdict, the recorded
   numbers and artifact integrity decide.
5. Deliver `REPORT.md` using §15.6. Every claim must name the case id and the field it came from.

Expected duration for one full run on this machine: **6–9 h** for the mandatory set, +3 h for the
optional stress cases. The suite is resumable: every case is independent once its inputs exist.

---

## 1. Ground rules for the executor

| # | Rule | Why |
|---|---|---|
| R1 | Geometry, QA, meshing, gating go through the plugin tools (`stl_*`, `mesh_*`) only. Shell is allowed for inspection, counting rows in CSV, computing analytic volumes, and the two documented post-steps (§5.4 patch retyping, Appendix B cfMesh dictionary). | The suite tests the plugin, not the executor's bash skills |
| R2 | No hand editing of STL, `snappyHexMeshDict`, `meshQualityDict`, `blockMeshDict`, `polyMesh/*`, or of a `mesh-passport.json`. | Hand edits hide plugin defects |
| R3 | Every number in the report must be traceable to a tool field, a log line, or an analytic formula written in the report. No "looks about right". | R1 of the project AGENTS.md |
| R4 | Never invent `locationInMesh`. Derive it with `benchmark/scripts/fluid_point.py` (Appendix A) or take it from a case listed here. | The classic `Point ... is not inside the mesh` failure |
| R5 | Budgets are hard stops: geometry ≤ 10 min, mesh ≤ 15 min, ≤ 3 M cells per case. On timeout record `BLOCKED` with the last log line; do not silently reduce parameters. | Keeps a full run bounded |
| R6 | One retry per case is allowed **only** for a documented environment failure (license, OOM, filesystem). Tool errors are defects, not retries. | Distinguishes noise from defects |
| R7 | Write only inside the run directory (`benchmark/runs/<id>/`). Temporary files elsewhere must be deleted before the report. | Reproducibility |
| R8 | Do not read `experiments/` to copy numbers into the report — this suite's baselines are in §17. Reading an existing case to *reuse its dicts* is allowed only where a case says so. | Independent measurement |

---

## 2. Environment

### 2.1 Mandatory

| Component | Expected | Check |
|---|---|---|
| Project root with `sim-project.json` | auto-detected from cwd | `mesh_hints({})` returns `versionInfo` and routes |
| `mesh-stl` tools | `stl_hints`, `stl_generate`, `stl_check` | `stl_generate({})` lists families incl. `primitive` |
| `mesh-build` tools | `mesh_hints`, `mesh_build`, `mesh_check`, `mesh_deliver` | `mesh_build({})` lists routes `snappy, cfmesh, gmsh, check` |
| Python | `<project>/.venv/bin/python` (trimesh, numpy, cadquery) | `fluid_point.py --help` runs |
| OpenFOAM installations in `sim-project.json` | `com2512` (default), `com2606`, `org14` | `mesh_check({ caseDir: ..., openfoam: "org14" })` resolves the id |

### 2.2 Version matrix (what each installation can do)

| Capability | com2512 | com2606 | org14 |
|---|---|---|---|
| `blockMesh`, `snappyHexMesh`, `checkMesh` | ✅ | ✅ | ✅ |
| `surfaceFeatureExtract` | ✅ | ✅ | ⚠️ stub: exits 0, writes nothing |
| `surfaceFeatures` + `system/surfaceFeaturesDict` | ❌ | ❌ | ✅ |
| `reconstructParMesh -mergeTol` | ✅ | ✅ | ❌ |
| `locationsInMesh` (multi-region) | ✅ | ✅ | ❌ (single `locationInMesh` only) |
| cfMesh (`cartesianMesh`, `pMesh`, `tetMesh`) | ✅ | ✅ | ❌ |
| `foamRun` / `foamMultiRun` | ❌ | ❌ | ✅ |
| `gmshToFoam`, `foamMeshToFluent`, `fluent3DMeshToFoam` | ✅ | ✅ | ✅ |

⚠️ The live DSH process caches `sim-core` ES modules. After changing anything under
`plugins/sim-core/`, a plugin reload (disable → enable) is not always enough: the host must be
restarted before a new config field is visible. Test runs in a fresh `node` process are unaffected.

---

## 3. Test catalogue

| Group | ID | Case | Purpose | Budget |
|---|---|---|---|---|
| A | A1 | Cube 10 mm | STL contract, exact volume/area | 2 min |
| A | A2 | Sphere r5 | Tessellation error, winding | 2 min |
| A | A3 | Cylinder d6 h10 | Curved surface, caps | 2 min |
| A | A4 | Box 20×10×5 (params override) | `params` deep-merge path | 2 min |
| B | B1 | Channel with 6 spheres (L3), snappy | Complex channel, fluid domain from `fluid.stl` | 10 min |
| B | B2 | Same channel, cfMesh | Second route on identical geometry | 10 min |
| B | B3 | Channel with 28 spheres (ref14) — optional | Stress geometry | 25 min |
| C | C1 | Sphere r5 in external box, level 1 vs 2 | Refinement actually applied; refinement study | 8 min |
| C | C2 | Cube 10 mm in external box | Sharp edges, feature capture | 5 min |
| C | C3 | Cylinder d6 h10 in cross-flow | Curved surface in external flow | 5 min |
| C | C4 | Crossing-cylinders block 12×6×6 | Flow around a complex shape with holes | 8 min |
| C | C5 | Channel-spheres solid, external flow | Irregular multi-body surface | 10 min |
| C | C6 | Double-layer burner — optional | Dense sphere assembly stress | 25 min |
| D | D1 | Suspension rheometry: packed cylinder D20 H20 | Dispersed-phase geometry, many bodies | 12 min |
| D | D2 | Dispersed-phase channel, interface level 3 | Interface refinement for VOF-like meshes | 12 min |
| D | D3 | Stratified two-layer channel | **Gap test** — generator absent | 5 min |
| E | E1 | FCC cell d5 r0.49 | Periodic pore cell baseline | 8 min |
| E | E2 | Mono packing 10×10×20, r1, gap 0.05 | Random porous medium | 12 min |
| E | E3 | Polydisperse packing r0.6–1.4 | Size distribution, thin gaps | 15 min |
| E | E4 | Double-layer burner solid — optional | Dense porous additive geometry | 25 min |
| F | F1–F12 | Hint retrieval | Correct card for 12 queries | 15 min |
| F | F13–F16 | Hint behaviour | Advice is applied and is correct | 20 min |
| G | G1–G10 | Tool contracts | Catalogues, dry run, passports, idempotency | 30 min |
| H | H1–H9 | Negative & robustness | Clear failures instead of silent nonsense | 30 min |
| V | V1–V4 | Versions | Same geometry on com2512 / com2606 / org14 + gmshToFoam | 15 min |
| L | L1–L3 | Delivery | `mesh_deliver` guards and artifacts | 10 min |

**Mandatory:** A1–A4, B1, B2, C1–C5, D1–D3, E1–E3, F1–F16, G1–G10, H1–H9, V1–V4, L1–L2.
**Optional (stress):** B3, C6, E4, L3.

---

## 4. Conventions

### 4.1 Units

* Generators and QA speak **millimetres**: `stl_generate` params, `stl_check` volume/area/bbox.
* `mesh_build` scaffold speaks **metres**: `domainMin`, `domainMax`, `cellSize`, `locationInMesh`.
* A scaffolded case stores `convertToMeters 1`, geometry blocks carry `scale 0.001` for the mm STL.
  Do not "fix" this — it is the intended convention.

### 4.2 `minVol` is an absolute volume

`minVol` in `meshQualityDict` is the volume of the face–cell-centre pyramid, **not** a fraction of
the cell. Use

```
h_min   = cellSize / 2^maxLevel          # metres
minVol  = h_min^3 / 6                    # m^3
```

Per-case values below are computed with this formula (rounded down). A too-large `minVol` marks
healthy cells as illegal and can also suppress layers; a missing `minVol` disables the check and
the gate returns a PASS with an advisory — that is a valid state, but it must be recorded.

### 4.3 Gate profiles

| Profile | maxNonOrtho | boundarySkew | internalSkew | minFaceWeight | minVolRatio | minDeterminant |
|---|---|---|---|---|---|---|
| `project` (default) | 60° | 4 | 2 | 0.1 | 0.05 | 0.001 |
| `gate` | 65° | 20 | 4 | 0.05 | 0.01 | 0.001 |
| `relaxed` | 75° | 20 | 4 | 0.05 | 0.01 | 0.001 |

Verdict is computed from the `checkMesh` **text** (`Failed N mesh checks`, `Mesh OK`,
threshold lines). `checkMesh` exits 0 even on quality failures — never use its exit code.

### 4.4 Case record

Every case writes `record.json`:

```json
{
  "case": "B1", "group": "B", "verdict": "PASS",
  "started_at": "2026-11-25T18:00:00+07:00", "duration_s": 214,
  "tools": ["stl_generate", "stl_check", "mesh_build", "mesh_check"],
  "inputs": {"preset": "channel_spheres_L3", "route": "snappy", "openfoam": "com2512"},
  "stl": [{"file": "fluid.stl", "verdict": "PASS", "watertight": true,
           "bodies": 1, "volume_mm3": 162.7341, "volume_expected_mm3": 162.7341}],
  "mesh": {"caseDir": "mesh/b1", "cells": 0, "maxNonOrtho": 0, "avgNonOrtho": 0,
           "maxSkewness": 0, "minVolume": 0, "gate": "PASS", "violations": []},
  "passport": {"status": "fresh", "agree": true, "recordedCells": 0},
  "hints": [{"query": "minVol layers", "expected_top3": ["snappy-minvol"], "got": ["snappy-minvol"]}],
  "artifacts": ["logs/plugin-snappy-04-snappyHexMesh-parallel.log"],
  "defects": [], "notes": ""
}
```

---

## 5. Group A — primitives (STL contract)

### A1. Cube 10 mm

**Goal:** exact box geometry; confirms the `primitive` family, binary STL writer and QA numbers.

```json
stl_generate({ "family": "primitive", "preset": "cube_10mm", "name": "a1-cube",
               "outDir": "benchmark/runs/<RUN>/stl/a1" })
```

Expected files: `a1-cube.stl` (clean), `a1-cube.generator.json`, `a1-cube.params.json`, `logs/step-1.log`.

```json
stl_check({ "stl": "benchmark/runs/<RUN>/stl/a1/a1-cube.stl",
            "expectVolume": 1000, "expectArea": 600, "expectBodies": 1,
            "maxVolumeErr": 0.01, "maxAreaErr": 0.01 })
```

| Check | Expected |
|---|---|
| `verdict` | `PASS` |
| triangles | 12 |
| watertight / winding | true / true |
| bodies | 1 |
| volume / area | 1000 mm³ / 600 mm², error ≤ 0.01 % |
| bbox | 10 × 10 × 10 mm |

**Mesh smoke (A1m):**

```json
mesh_build({ "route": "snappy", "caseDir": "benchmark/runs/<RUN>/mesh/a1",
  "scaffold": true, "stl": ["benchmark/runs/<RUN>/stl/a1/a1-cube.stl"],
  "scaffoldOptions": {
    "domainMin": [-0.002, -0.002, -0.002], "domainMax": [0.012, 0.012, 0.012],
    "cells": [20, 20, 20], "locationInMesh": [0.006, 0.006, 0.006],
    "refinementLevels": { "a1-cube": 2 }, "defaultLevel": 1, "minVol": 8e-13
  },
  "gate": true, "profile": "project" })
```

Acceptance: `ok: true`, steps `blockMesh → surfaceFeatureExtract → snappyHexMesh`, gate `PASS`,
no `Failed N mesh checks`. Record `cells`: the background alone is `20³`; refined cells make the
real count larger, and there is no fixed target — the sanity range is `10³ … 3·10⁵`.

### A2. Sphere r5

```json
stl_generate({ "family": "primitive", "preset": "sphere_r5", "name": "a2-sphere",
               "outDir": "benchmark/runs/<RUN>/stl/a2" })
stl_check({ "stl": "…/a2-sphere.stl", "expectVolume": 523.598776,
            "expectArea": 314.159265, "expectBodies": 1,
            "maxVolumeErr": 2.0, "maxAreaErr": 2.0 })
```

Expected: 960 triangles, watertight, 1 body, tessellated volume ≈ 515.24 mm³ (−1.6 % vs analytic),
area within 2 %. This case proves the tolerance is understood: a 1 % volume limit would fail a
legitimate faceted sphere — the recorded error must be explained, not "fixed".

### A3. Cylinder d6 h10

```json
stl_generate({ "family": "primitive", "preset": "cylinder_d6_h10", "name": "a3-cyl",
               "outDir": "benchmark/runs/<RUN>/stl/a3" })
stl_check({ "stl": "…/a3-cyl.stl", "expectVolume": 282.743339,
            "expectArea": 245.044227, "expectBodies": 1,
            "maxVolumeErr": 1.0, "maxAreaErr": 1.0 })
```

Expected: 192 triangles, 1 body, volume ≈ 281.9366 mm³ (−0.29 %). The caps are fans: check that
`degenerate_faces` is 0 and the winding is consistent.

### A4. Box 20×10×5 via params override

```json
stl_generate({ "family": "primitive", "preset": "cube_10mm", "name": "a4-box",
               "outDir": "benchmark/runs/<RUN>/stl/a4",
               "params": { "size_mm": [20, 10, 5] } })
stl_check({ "stl": "…/a4-box.stl", "expectVolume": 1000, "expectArea": 700, "expectBodies": 1 })
```

Expected bbox 20 × 10 × 5 mm, 12 triangles. This is the only test of `params` deep-merge for the
primitive engine; a failure here means the override silently ignored the new size.

**Group A verdict:** PASS only if all four STLs pass and A1m reaches gate PASS.

---

## 6. Group B — complex channels

Geometry: `channel_spheres_L3` — 6 spheres, r = 2.5 mm, square channel W = H = 3.5355 mm,
z = −12.5 … 7.0711 mm, 11 contact necks, fluid volume 162.7341 mm³, solid 81.9042 mm³,
porosity 0.6652, `fluid_patches.stl` 8 352 triangles (inlet 2, outlet 38, walls 460, interface 7 852).

### B1. Channel, snappy, single fluid region

```json
stl_generate({ "family": "channel-spheres", "preset": "channel_spheres_L3",
               "name": "b1-channel", "outDir": "benchmark/runs/<RUN>/stl/b1" })
```

```json
stl_check({ "stl": "…/fluid.stl",  "expectVolume": 162.7341, "expectBodies": 1,
            "maxVolumeErr": 0.5 })
stl_check({ "stl": "…/solid.stl",  "expectVolume": 81.9042,   "expectBodies": 1,
            "maxVolumeErr": 0.5 })
stl_check({ "stl": "…/fluid_patches.stl", "expectBodies": 1 })
```

Mesh the fluid domain from the closed `fluid.stl`. Point from Appendix A:
`fluid_point.py …/fluid.stl --clearance 0.2` (a verified example point is
`[0.044194, 0.044194, −2.114369]` mm; it lies in the inlet plenum).

```json
mesh_build({ "route": "snappy", "caseDir": "benchmark/runs/<RUN>/mesh/b1",
  "scaffold": true, "stl": ["benchmark/runs/<RUN>/stl/b1/fluid.stl"],
  "scaffoldOptions": {
    "domainMin": [-0.001, -0.001, -0.0135], "domainMax": [0.0045355, 0.0045355, 0.0080711],
    "cells": [18, 18, 72], "locationInMesh": [0.0017678, 0.0017678, -0.003],
    "refinementLevels": { "fluid": 2 }, "defaultLevel": 1, "minVol": 5e-14
  },
  "gate": true, "profile": "project" })
```

Acceptance: `ok: true`; gate `PASS`; `maxNonOrtho < 60`; `maxSkewness < 2`;
`minVolume ≥ minVol`; cells recorded (order 10⁵); wall time ≤ 600 s.
The patch type after scaffold is `wall` for every surface — record it; retyping `inlet`/`outlet`
is a documented post-step (Appendix C), not part of the plugin test.

### B2. Same channel, cfMesh (com only)

cfMesh needs a prepared case with `system/meshDict`; scaffold only writes snappy dicts. Prepare the
case with Appendix B, then:

```json
mesh_build({ "route": "cfmesh", "caseDir": "benchmark/runs/<RUN>/mesh/b2",
             "stl": ["benchmark/runs/<RUN>/stl/b1/fluid_patches.stl"],
             "np": 1, "gate": true, "profile": "project", "minVol": 1.5e-13,
             "openfoam": "com2512" })
```

Acceptance: mesh builds (`ok: true` for the run step), a gate verdict is produced **and diagnosed**.
cfMesh on pore-scale geometry is known to exceed the `project` gate on non-orthogonality/skewness
(historical result: FAIL). A PASS is a positive surprise; a FAIL with concrete `violations[]` and
`maxNonOrtho`/`maxSkewness` numbers is the expected 🟡 outcome. A FAIL with empty metrics is a
**BLOCKER** defect.

### B3. Channel ref14 — optional stress

`preset: "channel_spheres_ref14"` (28 spheres, 56 670 interface triangles, L ≈ 45.96 mm). Same
recipe as B1 but budget 25 min. Record cells, time, verdict. Purpose: does the plugin survive a
real-size case with a parallel run (`np: 6`)? Add `"np": 6` to B1's call and check that the plan
contains `decomposePar → snappyHexMesh -parallel → reconstructParMesh`.

---

## 7. Group C — external flow

All cases in this group use `symmetry` on the outer domain (scaffold default) and no inlet/outlet.
The point of the case is surface capture and refinement behaviour, not a solver-ready case.

### C1. Sphere r5 — refinement study

Run twice, `level 1` then `level 2`, identical domain:

```json
mesh_build({ "route": "snappy", "caseDir": "benchmark/runs/<RUN>/mesh/c1-l1",
  "scaffold": true, "stl": ["…/a2-sphere.stl"],
  "scaffoldOptions": { "domainMin": [-0.010, -0.010, -0.010], "domainMax": [0.030, 0.010, 0.010],
    "cells": [40, 20, 20], "locationInMesh": [0.020, 0, 0],
    "refinementLevels": { "a2-sphere": 1 }, "defaultLevel": 0, "minVol": 2e-11 } })
```

Then the same with `caseDir …/c1-l2`, `refinementLevels { "a2-sphere": 2 }`, `minVol 2.5e-12`
(the level-1 threshold is larger: `h_min = 0.5 mm` → `2e-11`; at level 2 `h_min = 0.25 mm` → `2.5e-12`).

Acceptance: both gate `PASS`; cells(level 2) ≥ 1.8 × cells(level 1); no negative volumes; the
surface patch is present in `boundary`. This is the cheapest way to catch a scaffold that ignores
`refinementLevels`.

### C2. Cube 10 mm in external box

`stl a1-cube.stl`; domain `[-0.010,-0.008,-0.008] … [0.030,0.008,0.008]`, cells `[40,16,16]`,
location `[0.020,0,0]`, level 2, minVol `2.5e-12`. Acceptance: gate PASS; edges are resolved
(v2512 has no `uncovered faces` line — instead check that every domain face is
assigned to a patch: `checkMesh`/`constant/polyMesh/boundary`).

### C3. Cylinder d6 h10 in cross-flow

`stl a3-cyl.stl`; domain `[-0.010,-0.010,-0.007] … [0.030,0.010,0.007]` metres (note z ±7 mm so the
cylinder ends are inside), cells `[40,20,14]`, location `[0.020,0,0]`, level 2, minVol `2.5e-12`.
Acceptance: gate PASS; the cylinder surface patch has > 0 faces; record `maxNonOrtho`.

### C4. Crossing-cylinders block (complex shape)

```json
stl_generate({ "family": "cad-porous", "preset": "channel_crossing_cylinders",
               "name": "c4-junction", "outDir": "benchmark/runs/<RUN>/stl/c4" })
stl_check({ "stl": "…/c4-junction.raw.stl" })   // on this preset the raw STL may already be watertight
                                                // → PASS; watch the warning about degenerate faces
stl_check({ "stl": "…/c4-junction.raw.stl", "cleanup": true,
            "cleanOut": "benchmark/runs/<RUN>/stl/c4/c4-junction.clean.stl",
            "expectVolume": 367.809705, "expectBodies": 1, "maxVolumeErr": 0.5 })  // expected PASS
```

Geometry: block 12 × 6 × 6 mm minus six through-cylinders R = 0.8 mm (three along Y, three along Z
at x = 3, 6, 9), volume `432 − 6πR²·6 + 3·(16/3)R³ = 367.809705 mm³`.
cad-porous emits a raw OCC STL; on the `channel_crossing_cylinders` preset it is already watertight
(0 degenerate faces, cleanup removes 0 triangles) — "the raw one must fail" is not guaranteed.
Mesh the clean STL:

```json
mesh_build({ "route": "snappy", "caseDir": "benchmark/runs/<RUN>/mesh/c4",
  "scaffold": true, "stl": ["…/c4-junction.clean.stl"],
  "scaffoldOptions": { "domainMin": [-0.002, -0.002, -0.002],
    "domainMax": [0.014, 0.008, 0.008], "cells": [16, 10, 10],
    "locationInMesh": [0.013, 0.007, 0.007],
    "refinementLevels": { "c4-junction.clean": 2 }, "defaultLevel": 1, "minVol": 2.5e-12 } })
```

Acceptance: gate PASS; every domain face is assigned to a patch (v2512 has no `uncovered faces` line);
record cells and `maxNonOrtho`.
A second variant, optional: `scaffoldOptions.refinementLevels` level 3 — cells must grow ≥ 1.5 ×.

### C5. Channel-spheres solid, external flow (irregular multi-body surface)

`stl` = `benchmark/runs/<RUN>/stl/b1/solid.stl`; domain `[-0.002,-0.002,-0.0045] … [0.0055,0.0055,0.0091]`, cells
`[19,19,34]` (≈ 0.4 mm), location `[0.005,0.005,0.008]`, level 2, minVol `7.5e-14`.
Acceptance: builds; gate PASS or a diagnosed FAIL; record cells/`maxNonOrtho`. This is the case
where a naive scaffold usually leaves the point inside a sphere — R4 applies.

### C6. Double-layer burner — optional stress

`preset: "double_layer_burner_d5_fine167"`, solid output is a dense sphere assembly
(`--solid-clean-out` path). Budget 25 min. Record cells/time; do not require a PASS — require a
diagnosed verdict.

---

## 8. Group D — multiphase rheometry

"Multiphase" here means **geometry for multiphase flow**: a dispersed phase resolved as solid
inclusions (suspension) or an interface that must be refined (VOF-like). The plugins do not set up
physics; the test is whether the mesh can carry it.

### D1. Suspension rheometry — packed cylinder

Packing preset `cylinder_d150_h500_balls_d10` overridden to a test-size cylinder:

```json
stl_generate({ "family": "packing", "preset": "cylinder_d150_h500_balls_d10",
  "name": "d1-susp", "outDir": "benchmark/runs/<RUN>/stl/d1",
  "params": {
    "container": { "type": "cylinder", "center_xy_mm": [10, 10],
                   "radius_mm": 10, "z_range_mm": [0, 20] },
    "radii": { "policy": "constant", "r_mm": 1.0 },
    "gap_mm": 0.05, "wall_gap_mm": 0.05, "max_spheres": 400, "seed": 11
  } })
```

Let `N` = number of data rows in `d1-susp.balls.csv`. Expected:

* solid: volume `N·(4/3)π mm³`, error ≤ 1 % (gap 0.05 is negligible); `bodies` = number of clusters
  (N = 400 → 51), not N — the generator merges touching spheres;
* fluid: `bodies = 1`, volume `π·10²·20 − N·(4/3)π mm³` (±1 %);
* both watertight.

Mesh the fluid domain from `d1-susp.fluid.stl`:

```json
mesh_build({ "route": "snappy", "caseDir": "benchmark/runs/<RUN>/mesh/d1",
  "scaffold": true, "stl": ["…/d1-susp.fluid.stl"],
  "scaffoldOptions": { "domainMin": [-0.001,-0.001,-0.001], "domainMax": [0.021,0.021,0.021],
    "cells": [44,44,44], "locationInMesh": [<from fluid_point.py>],
    "refinementLevels": { "d1-susp.fluid": 2 }, "defaultLevel": 1, "minVol": 1.5e-13 },
  "gate": true, "profile": "project" })
```

Acceptance: gate PASS; the STL QA reported `bodies = N`; after meshing the fluid domain has **one**
surface patch covering all cavity walls (snappy reads a single `triSurfaceMesh`, so it cannot emit
one patch per sphere) — record its face count, not a patch count of `N`. If the number of bodies in
the STL QA is not `N`, the packing writer merged touching spheres: that is a finding to record
(gap too small for the requested precision), not automatically a gate failure.

### D2. Dispersed-phase channel — interface refinement

Reuse B1's geometry; refine the interface one level further:

```json
mesh_build({ "route": "snappy", "caseDir": "benchmark/runs/<RUN>/mesh/d2",
  "scaffold": true, "stl": ["…/fluid.stl"],
  "scaffoldOptions": { "domainMin": [-0.001,-0.001,-0.0135],
    "domainMax": [0.0045355,0.0045355,0.0080711], "cells": [18,18,72],
    "locationInMesh": [0.0017678,0.0017678,-0.003],
    "refinementLevels": { "fluid": 3 }, "defaultLevel": 1, "minVol": 4.1e-15 },
  "gate": true, "profile": "project" })
```

Acceptance: gate PASS; cells ≥ 1.3 × B1 (interface refinement must be visible); time ≤ 900 s.
Record the ratio — this is the number a VOF user needs before committing to interface resolution.

### D3. Stratified two-layer channel — **gap test**

Goal: a channel with a flat internal interface between two immiscible layers. Current generators
(`fcc-cell`, `channel-spheres`, `double-layer-burner`, `packing`, `cad-porous`, `primitive`) cannot
produce one: `cad-porous` only cuts spheres/cylinders, `primitive` writes single convex shapes.

Expected outcome: **GAP**, not a plugin failure. Record:

```
stl_generate({ family: "…" })  →  families list has no interface/stratified generator
```

and propose in the report: a new family `stratified-channel` with params
`{domain, layer_height_mm, interface_plane}` producing `lower.stl` / `upper.stl` or one closed fluid
STL with an internal patch. Acceptance of the gap record: the claim is evidenced by the family
list output and the `data/generators.json` entry names.

---

## 9. Group E — porous media

### E1. FCC cell d5 r0.49 (periodic pore cell)

```json
stl_generate({ "family": "fcc-cell", "preset": "fcc_cell_d5_r049", "name": "e1-fcc",
               "outDir": "benchmark/runs/<RUN>/stl/e1" })
stl_check({ "stl": "…/e1-fcc.stl", "expectBodies": 1 })
```

Geometry: quarter FCC cell, sphere r = 2.45 mm (0.49·d), necks r/d = 0.1, depth 1.5 d, domain
3.5355 mm cube. Record the generator's `volume_mm3` from `e1-fcc.generator.json` — a quarter cell
has no simple closed-form volume, so the QA test is watertight + 1 body + stable volume on rerun
(run twice, compare sha256 of the clean STL).

Baseline mesh (same as the historical exp-003 case): background `cells [14,14,28]`, surface level 2,
fluid point `[0.00176777,0.00176777,0.00176777]` m, minVol `1e-14`.

```json
mesh_build({ "route": "snappy", "caseDir": "benchmark/runs/<RUN>/mesh/e1",
  "scaffold": true, "stl": ["…/e1-fcc.stl"],
  "scaffoldOptions": { "domainMin": [0,0,0], "domainMax": [0.0035355339,0.0035355339,0.0070710678],
    "cells": [14,14,28], "locationInMesh": [0.00176777,0.00176777,0.00176777],
    "refinementLevels": { "e1-fcc": [1, 2] }, "defaultLevel": 1, "minVol": 1e-14 },
  "gate": true, "profile": "project" })
```

Acceptance: gate PASS; `maxNonOrtho ≤ 60`; cells recorded (baseline order 2.7 × 10⁴);
`maxSkewness < 2`; time ≤ 480 s. Baseline from exp-003: 27 424 cells, maxNonOrtho 41.342343,
avg 11.793339, skew 1.3330913, minVol 1.0720515e-13 — allowed drift ±15 % on cells, ±3° on
non-orthogonality for the same parameters.

### E2. Mono packing 10×10×20, r1, gap 0.05

```json
stl_generate({ "family": "packing", "preset": "box_mono_d1", "name": "e2-pack",
  "outDir": "benchmark/runs/<RUN>/stl/e2",
  "params": {
    "container": { "type": "box", "lo_mm": [0,0,0], "hi_mm": [10,10,20] },
    "radii": { "policy": "constant", "r_mm": 1.0 },
    "gap_mm": 0.05, "wall_gap_mm": 0.05, "max_spheres": 600, "seed": 11
  } })
```

`N` = rows in `e2-pack.balls.csv`. Expected solid volume `N·4.18879 mm³` (±1 %); fluid volume
`2000 − N·4.18879` (±1 %). **Do not** check `bodies = N`: the generator merges touching spheres
into clusters (N = 210 → 15 bodies, 195 contacts), so the expectation for bodies is `bodies = clusters` from
`<name>.packing.json`, and fluid = clusters + 1.

Mesh `e2-pack.fluid.stl`: domain `[-0.001,-0.001,-0.001] … [0.021,0.021,0.021]` m, cells
`[40,40,80]` (0.55 mm), level 2, minVol `9.9e-15`, location from Appendix A.

Acceptance: gate PASS; cells 10⁵–10⁶; time ≤ 720 s. Record `N`, the fluid volume error, and the
face count of the single cavity patch (one surface file — see D1's note). A gate FAIL with minVol
violations here is a real finding: the 0.05 mm gaps are 0.09 × the base cell and 0.23 × the refined
cell — record the advisory and the `minVolSuggestion` returned by `mesh_check`.

### E3. Polydisperse packing r0.6–1.4

Container `8 × 8 × 12 mm` (smaller than E2 so the 0.25 mm cells stay under the 3 M budget),
`radii: { policy: "uniform", r_min: 0.6, r_max: 1.4 }`, `gap_mm: 0.05`, `wall_gap_mm: 0.05`,
`max_spheres: 600`, `seed: 11`. Solid volume `Σ(4/3)πr_i³` from the CSV (compute with `awk`/python
— R1 allows this); fluid volume `768 − Σ`.
Mesh: domain `[-0.001,-0.001,-0.001] … [0.013,0.013,0.013]` m, cells `[56,56,56]` (0.25 mm),
level 2, minVol `1.5e-14`, location from Appendix A.
Acceptance: both STLs PASS; gate PASS or diagnosed; the smallest sphere r = 0.6 must be resolved —
check that the minimum gap in `contacts.csv` is ≥ 2 × `MeshSizeMin`; if it is not, record a
**design-rule violation** (gap rule, `stl` card `gap-rule`), not a mesher bug.

### E4. Double-layer burner — optional stress

`preset: "double_layer_burner_d5_fine167"` solid, cleaned. This is the densest geometry available
(three sphere layers per coarse cell, gaps 10⁻⁴ mm). Expect a long run; record cells/time and gate
verdict. Do not require PASS.

---

## 10. Group F — hints

Hints are part of the product: a correct tool with wrong advice is a defect.

### F1–F12. Retrieval contract

For each query, call `mesh_hints({ query })` (or `stl_hints`) and record the returned ids.

| # | Query | Expected in top 3 (merged catalogue, measured) |
|---|---|---|
| F1 | `minVol layers` | `minvol-absolute`, `snappy-minvol`, `cfmesh-layers-tetra` |
| F2 | `interface refinement level` | `snappy-interface-level`, `snappy-domain-plane-spots` |
| F3 | `cfMesh layers tetra` | `cfmesh-layers-tetra`, `cfmesh-cartesian`, `openfoam-versions` |
| F4 | `org14 cfmesh version` | `openfoam-versions`, `cfmesh-cartesian` |
| F5 | `watertight cleanup units` | `stl-contract`, `stl-cleanup`, `units-mm` |
| F6 | `sphere packing contacts` | `packing-pipeline`, `channel-named-patches` |
| F7 | `gmsh tetra pore` | `gmsh-tetra-unfit`, `gmsh-route-d` |
| F8 | `delivery passport` | `delivery-bundle`, `fluent-start` |
| F9 | `symmetry domain plane spots` | `snappy-symmetry-domain`, `snappy-domain-plane-spots` |
| F10 | `castellated buffer layer solver` | `snappy-buffer-layer-solver` |
| F11 | `parallel snappy recipe` | `snappy-parallel-recipe` |
| F12 | `quality gate thresholds` | `quality-gate`, `snappy-quality-gate`, `snappy-minvol` |

These expectations were produced by the merged service store on 2026-11-25 (33 cards), not by
reading the JSON files: the borrowed cards (`mesh-stl` → `mesh-build`) are part of the answer.

Acceptance: expected id appears in `matches[0..2]`; each card has non-empty `evidence` naming a
file or experiment; a query that returns nothing must return an empty `matches` with `total: 0`
(no fabricated card).

### F13–F16. Behaviour contract (the advice must change the answer)

| ID | Check | Correct behaviour |
|---|---|---|
| F13 | `mesh_check` on a case without `minVol` | PASS/UNKNOWN with `advisory` naming `disabled-minVol-not-configured`; the answer must not claim the mesh is quality-verified |
| F14 | `mesh_check` on a mesh whose `minVolume` is below the requested `minVol` | `verdict: FAIL`, `failKind: minVol-threshold`, `minVolSuggestion ≈ minVolume/12`, `violations` includes the exact `faces with face pyramid volume < … : N` line |
| F15 | `mesh_build({ route: "cfmesh", openfoam: "org14" })` | refused with a message naming `cartesianMesh` and suggesting `openfoam:"com2606"` or route `snappy/gmsh`; no partial case left behind |
| F16 | `mesh_build({ route: "snappy", openfoam: "org14", scaffold: true, dryRun: true })` | plan contains `surfaceFeatures` (not `surfaceFeatureExtract`) and no `reconstructParMesh -mergeTol` |

F13–F16 are the real test of "tools + hints": the card text says the rule, the tool must implement it.

---

## 11. Group G — tool contracts

| ID | Action | Expected |
|---|---|---|
| G1 | `stl_generate({})` | families include `primitive`, `packing`, `channel-spheres`, `cad-porous`; each shows presets |
| G2 | `mesh_build({})` | routes `snappy(8 steps)`, `cfmesh(6)`, `gmsh(3)`, `check(0)`; profiles `gate`, `project` |
| G3 | `mesh_build({ ... dryRun: true })` | `plan` present; `<caseDir>` does not exist afterwards (or is unchanged) |
| G4 | real `mesh_build` after G3, same args | executed `steps.names` equals the dry-run plan names |
| G5 | `stl_check({ stl: "nope.stl" })` | `{ error: "STL not found: …" }`, no stack trace, no file created |
| G6 | `mesh_check({ caseDir: "<empty dir>" })` | `{ error: "no constant/ directory …" }` |
| G7 | `mesh_check` on A1m case | writes `mesh-passport.json` with `status fresh`, `cells = fluid cells`, `gate.verdict PASS`; passport contains `environment.id` |
| G8 | touch `constant/polyMesh/points`, rerun `mesh_check` | since 2026-11-25 `mesh_check` computes freshness BEFORE overwriting the passport: `status: "stale"`, `changed` names `constant/polyMesh/points (content changed)` |
| G9 | `stl_check({ ..., register: true })` twice with different `geom_id`-relevant names | exactly one row appended per call; header unchanged; a wrong-header CSV is refused with a message |
| G10 | same `mesh_build` twice into different `caseDir`s | identical `cells` and gate verdict (snappiness determinism); wall time recorded |

Acceptance: all ten pass. G4 is the honesty test for `dryRun`; G7/G8 are the passport contract that
`mesh_deliver` depends on.

---

## 12. Group H — negative and robustness

| ID | Scenario | Expected |
|---|---|---|
| H1 | `stl_check` on `stl/e1/e1-fcc.raw.stl` (11 356 tri, 8 degenerate — the raw file is not watertight) | `verdict: FAIL` (since 2026-11-25 `stl_qa.py` treats "raw not watertight with no `--clean-out`" as a problem rather than a warning); `cleanup: true` → `verdict: PASS`, 11 348 tri, 1 body. The former example `c4-junction.raw.stl` is already PASS on this preset |
| H2 | `mesh_build` with `locationInMesh` at the centre of a closed solid (A2 sphere, `[0,0,0]`) | `ok: false`, `phase: "sanity"`, a message about the missing domain patch (`world`) — "locationInMesh most likely landed inside the solid body"; a point outside the domain is caught by the preflight `is outside the domain`. For the A1 cube the interior IS the fluid, so A1 does not exercise this test |
| H3 | `mesh_build({ route: "cfmesh", openfoam: "org14" })` | refused by preflight (same as F15); no `cartesianMesh` invocation in `steps` |
| H4 | `mesh_build` cfmesh on a case without `system/meshDict` | preflight refusal naming `meshDict` |
| H5 | `mesh_build({ route: "gmsh" })` without `gmshScript`/`msh` | preflight refusal naming both |
| H6 | `mesh_deliver` on a case without a passport | `verdict: BLOCKED`, reason `passport-missing`; `force: true` proceeds with a `passport-missing-forced` warning |
| H7 | `mesh_deliver` after touching `points` | `BLOCKED`, reason `passport-stale` |
| H8 | `mesh_check` on a gate-FAIL mesh with a different `minVol` | verdict flips when the threshold crosses `minVolume`; both answers show the numbers that justify the flip |
| H9 | `mesh_build` with an absurd `cellSize` (5e-5 m on a 14 mm domain) | since 2026-11-25 the scaffold writes `cellBudgetWarning` and returns `ok: false` with a `maxCells`/`maxGlobalCells` message (default `maxCells` 5e6) — not an OOM and not a truncated success |

Acceptance: every failure is **actionable**: names the file/field, suggests the fix, leaves no
half-written case that the next tool would accept. H1 is the STL-contract lesson; H2 and H3 are the
two most common real-world mistakes.

---

## 13. Group V — OpenFOAM versions

Same geometry (A1 cube STL) on three installations, using the exp-019 setup: domain
`[-0.002,-0.002,-0.002] … [0.012,0.012,0.012]` m, cells `[16,16,16]`, location `[0.001,0.001,0.001]`,
minVol `1e-12`, gate `project`. This is a version-regression case, not a smoke case — do not reuse
A1m's `20³` background here.

| ID | Call | Expected |
|---|---|---|
| V1 | snappy with `openfoam: "com2512"` | PASS; 2584 cells, maxNonOrtho ≈ 9.71°, skew ≈ 0.26 |
| V2 | snappy with `openfoam: "com2606"` | PASS; same numbers within 1 %; `environment.version = v2606` in the passport |
| V3 | snappy with `openfoam: "org14"` | PASS; 2584 cells, maxNonOrtho ≈ 25.21°, skew ≈ 0.33; step log shows `surfaceFeatures`, not `surfaceFeatureExtract` |
| V4 | gmsh route on `com2512` and `org14`, using `benchmark/scripts/gmsh_cube.py` (Appendix D) | `gmshToFoam` rc = 0 on both; `checkMesh` runs and reports cells (reference: 1135 tetra, maxNonOrtho ≈ 56.1°, skew ≈ 0.66); verdict recorded, PASS not required |

Baselines from exp-019 are the reference. Acceptance: all PASS; a difference in non-orthogonality
between org14 and com is expected (≈ 15°) and must be recorded as a version finding, not a defect.
If the id selector fails with `available: (none declared)` in a live DSH session, restart the host
first (§2.2) — record it as an environment note, not a plugin defect.

---

## 14. Group L — delivery

| ID | Scenario | Expected |
|---|---|---|
| L1 | L1: `mesh_deliver` on the A1m case after `mesh_check({ minVol: 8e-13 })` | `verdict: DELIVERED`; files exist: `openfoam_<name>/<name>.foam` (non-empty), `.tar.gz`, `ansys_<name>/<name>.msh`, `.zip`, `delivery_<name>.json`; report `cells=32718`, `roundtrip.ok=true` |
| L2 | edit `constant/polyMesh/points`, call `mesh_deliver` again | `BLOCKED` with `passport-stale`; `force: true` → `DELIVERED` plus a warning in `warnings[]` |
| L3 | optional: CHT `experiments/exp-018_snappy-parameter-study/cases/v13_best`, `force: true`, `minVol: 1e-16` | `DELIVERED`, `mode multi_region`, 575 757 cells, `interfaceOk: true`, gate PASS both regions, ~70 s |

Acceptance: L1 and L2 mandatory. The `.foam` marker must be non-empty (otherwise ParaView does not
associate it). `roundtrip` must be `true` with `fluent3DMeshToFoam`; the polyhedral caveat in the
report is expected (`fluentMeshToFoam` cannot read snappy polyhedra).

---

## 15. Protocol

### 15.1 Run directory

```
benchmark/runs/<YYYY-MM-DD>-<tag>/
  manifest.json            # environment, plugin versions, start/end, executor
  calls.csv                # one row per tool call
  metrics.json             # one object per case (schema below)
  stl/<case>/              # generator outputs (raw, clean, patches, csv, generator.json)
  mesh/<case>/             # cases, logs/, mesh-passport.json, .mesh-gate/
  logs/                    # copied tails for defects only
  REPORT.md
```

### 15.2 `calls.csv`

Header exactly:

```csv
seq,case,tool,args_json,started_at,duration_s,ok,error_class,error_message,artifacts,notes
```

* `args_json` — the arguments you actually passed, JSON on one line.
* `ok` — `true` only if the tool returned a non-error payload (a gate FAIL is `true`; an exception
  or `{error}` is `false`).
* `error_class` — `tool-error`, `gate-fail`, `preflight`, `timeout`, `defect`.
* Every tool call goes here, including catalogue calls and dry runs.

### 15.3 `metrics.json`

```json
{ "schema": "mesh-tests/1", "run": "<id>", "plugin_versions": {"mesh-stl": "0.3.0",
  "mesh-build": "0.5.0", "sim-core": "0.4.0"},
  "cases": [ { "case": "B1", "group": "B",
    "stl": {"verdict": "PASS", "bodies": 1, "volume_mm3": 162.7341, "volume_err_pct": 0.0},
    "mesh": {"route": "snappy", "openfoam": "com2512", "cells": 0, "maxNonOrtho": 0,
             "avgNonOrtho": 0, "maxSkewness": 0, "minVolume": 0, "minVol_threshold": 5e-14,
             "gate": "PASS", "violations": []},
    "passport": {"status": "fresh", "agree": true},
    "dur_s": 214, "verdict": "PASS", "defects": ["DEF-03"] } ] }
```

### 15.4 Verdicts

| Verdict | Meaning |
|---|---|
| `PASS` | every acceptance criterion of the case met |
| `FAIL` | the plugin did not meet a criterion; a defect id is attached |
| `BLOCKED` | could not run (environment/timeout/missing prerequisite); reason recorded |
| `GAP` | the capability does not exist by design (e.g. D3); proposal recorded |
| `XFAIL` | expected failure confirmed (documented limitation); not a regression |

### 15.5 Defects and severity

| Severity | Definition | Example |
|---|---|---|
| `BLOCKER` | wrong verdict, silent PASS, corrupted artifact, data loss | gate PASS on a mesh with `Failed 1 mesh checks` |
| `MAJOR` | a documented capability does not work, or advice is wrong | layer step suppressed on org14; hint says `minVol 1e-13` for 0.06 mm cells |
| `MINOR` | wording, field naming, missing `next` | error message without the path |
| `GAP` | capability absent, agreed as out of scope | stratified generator |

Every defect: `DEF-NN`, case id, tool, expected vs actual, exact message/log line, proposed fix
(file + function).

### 15.6 Scoring

| Dimension | Weight | What earns points |
|---|---|---|
| D1 Geometry | 20 | STL contract: watertight, winding, volume/area within stated tolerance, cleanup works, registry row |
| D2 Mesh quality | 25 | gate PASS on A/B/C/E cases; metrics near baselines; failures diagnosed with numbers |
| D3 Routes and versions | 20 | correct route per installation; org14/com differences handled; gmsh/cfMesh preflight |
| D4 Tools and hints | 20 | F group (12 retrieval + 4 behaviour) and G group (contracts) |
| D5 Protocol | 15 | every case recorded; calls.csv complete; no invented numbers; reproducible seeds |

Bands: **≥ 85** toolchain usable for production meshing; **70–84** usable with known workarounds;
**55–69** needs fixes before use; **< 55** not usable.

Hard zeroes: hand-edited mesh ⇒ D2 = 0; invented number ⇒ case = FAIL; mesh accepted without a
gate verdict ⇒ D2 = 0 for that case.

### 15.7 `REPORT.md` template

```markdown
# Mesh toolkit test run <run-id>
Environment: <OS, OpenFOAM ids, plugin versions> — started/finished, duration.

## 1. Verdict
<band + total score + counts PASS/FAIL/BLOCKED/GAP/XFAIL>

## 2. Summary table
| Case | Group | Verdict | STL | Cells | Gate | maxNO | skew | minVol | Time |
(one row per executed case)

## 3. Geometry (A, B-STL, C-STL, E-STL)
Per-case: exact measured vs expected, cleanup behaviour, defects.

## 4. Meshing (B, C, D, E)
Per-case: route, gate, threshold violations, comparison to baselines, timing.

## 5. Versions (V)
The three installations side by side; what the plugin did differently.

## 6. Hints and tools (F, G)
Retrieval matrix (query → expected → got), behaviour checks F13–F16, contract results.

## 7. Negative tests (H)
One row per scenario: expected message vs actual.

## 8. Delivery (L)
Artifacts, guard states, round-trip.

## 9. Defects
| ID | Severity | Case | What happened | Evidence (file:line / message) |

## 10. Backlog
P0 (blockers), P1 (major), P2 (minor), GAP proposals — each with file and effort.

## 11. Reproduction
Commands, seeds, tool versions, deviations from this protocol.
```

---

## 16. Execution order and budget

| Step | Cases | Wall time | Gate to next step |
|---|---|---|---|
| 1 | G1, G2, F1–F12 | 20 min | catalogues and hints load |
| 2 | A1–A4 (+A1m) | 20 min | all STLs PASS; A1m gate PASS |
| 3 | C1–C3 | 25 min | refinement study shows growth |
| 4 | E1, E2 | 30 min | gate verdict produced for both |
| 5 | B1, B2 | 30 min | channel verdicts documented |
| 6 | D1, D2 | 30 min | many-body and interface cases recorded |
| 7 | C4, C5, E3 | 40 min | complex and polydisperse cases |
| 8 | F13–F16, G3–G10 | 30 min | tool behaviour verified |
| 9 | H1–H9 | 30 min | every failure actionable |
| 10 | V1–V4 | 20 min | three versions agree/differ as documented |
| 11 | L1–L2 | 15 min | delivery artifacts and guards |
| 12 | D3, report | 30 min | gap documented, report complete |
| optional | B3, C6, E4, L3 | 90 min | stress only; may be BLOCKED |

If a step fails its gate: finish the group, mark affected later cases `BLOCKED` with the dependency
named, continue with independent groups. Never reorder the report to hide a skipped case.

---

## 17. Baselines and known gaps

### 17.1 Baselines (measured, reusable)

| Case | Reference | Numbers |
|---|---|---|
| V1–V3 | cube 10 mm, snappy, background `16³` (exp-019 setup) | com2512: 2584 cells, 9.7073° / 0.261026; com2606: 2584, 9.7073° / 0.261026; org14: 2584, 25.2146° / 0.334515 |
| A1m | cube 10 mm, background `20³` (this suite) | no reference yet — record actual; do not compare to the `16³` numbers |
| E1 | exp-003, same parameters | 27 424 cells, 41.342343° / 11.793339°, skew 1.3330913, minVol 1.0720515e-13 |
| L3 (CHT) | exp-018 v13_best, `minVol 1e-16` | 575 757 cells, gate PASS (fluid 331 792 / 18.7107°, solid 243 965 / 26.5365°) |
| B1/B2 | exp-017 (28-sphere channel) | 2-region snappy built; cfMesh built; project gate FAILED on non-ortho/skew |

A case may differ from a baseline because the parameters differ; the report must say which
parameters differ and why. `A1m` in this suite uses a finer background than exp-019 on purpose: it
is a smoke case, not a version regression (use V1–V3 for that).

### 17.2 Known gaps

1. **No stratified/interface generator** (D3) — two-layer channel cannot be produced; proposal in §8.
2. **No droplet/bubble family** — VOF bubble-train geometries are not available.
3. **No layer-quality acceptance** — `nSurfaceLayers` / layer coverage is only reported, not gated.
   A future test should read the snappy `Added N out of M cells (P%)` line and require `P ≥ 80`.
4. **cfMesh route has no scaffold** — the executor must write `system/meshDict` (Appendix B); a
   future `mesh_build` may accept `meshDict` in scaffold options.
5. **`org14` cannot do multi-region snappy** (`locationsInMesh` unsupported); CHT on org14 must go
   through the gmsh route (route D), which is not covered here yet.
6. **Polyhedral `.msh`** — snappy meshes convert to Fluent only via the legacy round-trip; reading
   them back with `fluentMeshToFoam` fails by design.
7. **Live DSH ESM cache** — new `sim-core` config fields require a host restart; a test that changes
   `sim-project.json` mid-run will otherwise see the old installations list.

---

## Appendix A — finding a valid `locationInMesh`

```bash
.venv/bin/python benchmark/scripts/fluid_point.py \
  benchmark/runs/<RUN>/stl/b1/fluid.stl --clearance 0.2 --seed 1
# the canonical script now ships in the package: plugins/mesh-build/scripts/fluid-point.py (a thin shim here)
# -> {"ok": true, "point_mm": [0.044194, 0.044194, -2.114369], "clearance_mm": 0.38, ...}
```

Then convert mm → m and pass the point as `scaffoldOptions.locationInMesh`. The script probes the same
nearest triangle for distance and side (`(p - closest).n`, negative = inside) over a (y,z) bucket index,
with `--max-seconds`/`--tries` budget and `best_clearance_mm` in the failure payload.
A "not found" result usually means the STL is open or the clearance is larger than the thinnest
passage — lower `--clearance` before assuming a geometry bug.

## Appendix B — cfMesh case preparation (B2)

`mesh_build` route `cfmesh` expects a case with a dictionary; scaffold it manually:

```bash
CASE=benchmark/runs/<RUN>/mesh/b2
mkdir -p "$CASE/constant/triSurface" "$CASE/system" "$CASE/0"
cp benchmark/runs/<RUN>/stl/b1/fluid_patches.stl "$CASE/constant/triSurface/"
cat > "$CASE/system/controlDict" <<'EOF'
FoamFile { version 2.0; format ascii; class dictionary; object controlDict; }
application cartesianMesh;
startFrom startTime; startTime 0;
stopAt endTime; endTime 1;
deltaT 1; writeControl timeStep; writeInterval 1;
EOF
cat > "$CASE/system/meshDict" <<'EOF'
FoamFile { version 2.0; format ascii; class dictionary; object meshDict; }
surfaceFile "constant/triSurface/fluid_patches.stl";
maxCellSize 0.2;
boundaryCellSize 0.2;
minCellSize 0.1;
// WARNING: cfMesh does not scale its input — these sizes are in METRES.
// For an STL in mm (or one converted with surfaceTransformPoints) 0.2 m = 200 mm.
renameBoundary {
  defaultName "unmatched"; defaultType wall;
  newPatchNames {
    "inlet"     { newName inlet; type patch; }
    "outlet"    { newName outlet; type patch; }
    "walls"     { newName walls; type wall; }
    "interface" { newName interface; type wall; }
  }
}
EOF
```

Then call `mesh_build({ route: "cfmesh", caseDir: "$CASE", ... })`. Note: the single STL file may
collapse the four named solids into one patch depending on the reader — record what
`constant/polyMesh/boundary` actually contains; that is a finding for the pipeline, not a reason to
edit the file inside the test.

## Appendix C — patch retyping (documented post-step)

Scaffold types every surface patch `wall`. For a flow-ready case the executor may retype
`inlet`/`outlet` **after** meshing and before any solver step, with a documented command:

```bash
# single region, com:
foamDictionary -entry boundary.inlet.type -set patch "$CASE/constant/polyMesh/boundary"
foamDictionary -entry boundary.outlet.type -set patch "$CASE/constant/polyMesh/boundary"
```

This is outside the plugin contract (§1 R1): record it in `record.json.notes`, do not let it change
the mesh verdict.

## Appendix D — gmsh route preparation (V4)

`gmshToFoam` reads the case `system/` dictionaries, so the case directory must exist and contain
`controlDict`, `fvSchemes`, `fvSolution` before the route runs. Copying them from a scaffolded case
(A1m) is case preparation, not mesh editing:

```bash
RUN=benchmark/runs/<RUN>
CASE="$RUN/mesh/v4"
mkdir -p "$CASE/system" "$CASE/constant"
cp "$RUN/mesh/a1/system/"{controlDict,fvSchemes,fvSolution} "$CASE/system/"
.venv/bin/python benchmark/scripts/gmsh_cube.py \
  --output "$CASE/cube.msh" --size 0.004 --extent 0.014
```

Then (absolute paths, because the route renders `{msh}` verbatim):

```json
mesh_build({ "route": "gmsh", "caseDir": "benchmark/runs/<RUN>/mesh/v4",
  "gmshScript": "benchmark/scripts/gmsh_cube.py",
  "gmshArgs": ["--output", "/abs/path/benchmark/runs/<RUN>/mesh/v4/cube.msh",
               "--size", "0.004", "--extent", "0.014"],
  "msh": "/abs/path/benchmark/runs/<RUN>/mesh/v4/cube.msh",
  "openfoam": "com2512", "gate": true, "profile": "project", "minVol": 1e-12 })
```

Expected steps: `build-msh → gmshToFoam` (plus `splitMeshRegions` only if asked). Reference from
the verified script run on this machine: 1135 tetrahedra, 14 mm cube, maxNonOrtho 56.1394°,
avg 21.4773°, max skewness 0.656994 — a raw `checkMesh` pass, but the `project` gate may reject the
tetrahedra on skewness/`minVol`; record the verdict, PASS is not required for V4. The `gmsh` route
is the documented fallback for org14 CHT (route D), not a production pore mesher.

---

*End of suite. When a case is ambiguous, prefer recording the ambiguity over inventing a number: an
honest `BLOCKED` is more useful than a polished false PASS.*

---

## 18. Protocol amendments after the 2026-11-25 run

Every item below follows from the `benchmark/runs/20261125-1805/` run (see `REPORT.md`, defects
DEF-01…DEF-18) and was applied together with the plugin fixes on the same day. The parameter values of the cases
(A1–A4, B1, C1–C5, D1–D3, E1–E3) did not change, except for `minVol`, which turned out to be stricter than the real
minimum cell volume, and obvious typos.

| What | Before | After | Why |
|---|---|---|---|
| E1 `domainMax` z | `0.0035355339` | `0.0070710678` | the FCC-cell STL is 7.0711 mm high; the previous domain cut off half the geometry, and the gate still returned PASS (DEF-11) |
| E1 `refinementLevels` | `{ "e1-fcc": 2 }` | `{ "e1-fcc": [1, 2] }` | a scalar level wrote `level (2 2)`; the pair `[1,2]` is the exp-003 convention (27 424 cells), otherwise 75 024 (+174 %) (DEF-12) |
| C5 `minVol` | `1.5e-13` | `7.5e-14` | the template value yields 5 "pyramid" violations on a healthy mesh (DEF-10) |
| D1 `minVol` | `3e-13` | `1.5e-13` | same, 12 violations (DEF-10) |
| D2 `minVol` | `8e-15` | `4.1e-15` | same, 3 violations (DEF-10) |
| E2 `minVol` | `4e-13` | `9.9e-15` | same, 2 350 384 violations (DEF-10) |
| E3 `minVol` | `3e-14` | `1.5e-14` | same, 117 violations (DEF-10) |
| D1/E2 "bodies = N" | `bodies = N` | `bodies = clusters` | the generator merges touching spheres: D1 400 → 51, E2 210 → 15, E3 93 → 9 (DEF-06/DEF-14) |
| C4/H1 "the raw STL must fail" | "raw OCC STL is not watertight" | "on this preset the raw STL may already be watertight" | the actual result is PASS with 0 degenerate faces (DEF-05); the non-watertight example for H1 is `stl/e1/e1-fcc.raw.stl` |
| `uncovered faces` | "snap log reports no uncovered faces" | "v2512 has no such line, check how the faces are distributed over the patches" | the line appears neither in the logs nor in the v2512 sources |
| L1 `cells` | `2584` | `32718` | A1m (20³ background) actually gives 32 718 cells; 2584 is V1 (16³) |
| Appendix B `meshDict` | `maxCellSize 2e-4`, `boundaryCellSize 2e-4`, `minCellSize 1e-4` | `0.2`, `0.2`, `0.1` (metres) | cfMesh does not scale its input: with a mm-STL the octree goes to level 18 and the step times out (DEF-03) |
| H2 | a point inside the solid | the centre of a closed solid (A2) | A1 cube: the interior IS the fluid; the new sanity guard catches a missing domain patch (DEF-17) |
| H9 | "wait for the budget message" | the guard is implemented (`maxCells`, default 5e6) | the run created 21.95 million background cells and 476 MB with no warning (DEF-18) |
| G8 | "passport status stale" | freshness is computed BEFORE the passport is overwritten | `mesh_check` overwrote the passport and always reported `fresh` (DEF-09) |
| G7 / V2 `environment` | `environment.id` / `environment.version = v2606` | these require a DSH restart | the live process keeps `mesh-build@0.2.0` in the ESM cache and does not write `environment` (DEF-08/ENV-1) |
| D3 | no stratified geometry | the `stratified-channel` family (`geometry/stratified/`, preset `channel_10x10x20_h8`) | the GAP is closed: lower/upper STL split by the plane `interface_z_mm` (DEF-07) |
| F3/F4/F5/F7 (hints) | a single mesh-build directory | `mesh_hints` also registers `mesh-stl/data/hints` — 33 cards | `openfoam-versions` and the STL cards are now found on the first query (DEF-15/DEF-16) |

Verification of the amendments: `benchmark/runs/20261125-1805/REPORT.md` §10 (the "Re-check after the amendments" section).
