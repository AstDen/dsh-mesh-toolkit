# Benchmark prompt — `mesh-stl` + `mesh-build`

> Copy everything below into a fresh DSH session with both plugins installed and the
> source project available. The session must produce a strict product evaluation, not
> a one-off mesh. Two tasks exercise the toolkit on **generic primitives** and on a
> **sphere packing** — no project-specific experiment directories are involved.

## 1. Role and goal

You are evaluating two DSH plugins as products:

- `mesh-stl` — `stl_hints`, `stl_generate`, `stl_check`;
- `mesh-build` — `mesh_hints`, `mesh_build`, `mesh_check`.

Your job: generate the two geometries below, mesh them, gate them, and write a
report that answers three questions with evidence:

1. Where are the tools strong?
2. Where do they break, mislead, or need manual work?
3. What should be improved next, in what order?

Do not "rescue" the tools by hand. If something cannot be done through the tools,
record it as a finding — that is data, not failure of the benchmark.

## 2. Rules

1. Only the six plugin tools may generate geometry, run STL QA, build meshes or gate
   them. Shell is allowed for inspection (`ls`, `du`, `sha256sum`, `grep`/`head` on
   logs, reading CSV/JSON artifacts) and for computing coordinates, never for editing
   an STL or a mesh.
2. Do not hand-edit `polyMesh`, `boundary`, dictionaries or STL files. Do not invoke
   generators, `snappyHexMesh`, `cfMesh`, `checkMesh` or `mesh_gate.sh` directly.
3. Do not read project `experiments/` for expected values or fixes. Expected values
   are given below; everything else must come from your own run.
4. Every number in the report must be traceable to a tool result, a log line, or the
   analytic formula quoted here. Estimates are forbidden.
5. Record **every** tool call in `calls.csv` (schema in §8), including failures and
   repeated calls.
6. Budgets: geometry ≤ 10 min per case, meshing ≤ 15 min per case, ≤ 3 000 000 cells.
   On overrun, stop the call, record it, and continue.
7. If a tool fails: record the exact error, diagnose the cause (tool / docs /
   environment / parameters), retry at most once with a justified change, then move
   on. Never loop on the same arguments.
8. Leave the plugin sources untouched. The benchmark writes only under
   `benchmark/run-<timestamp>/`.

## 3. Environment

- Project root: auto-detected by the plugins (`.venv/`, `tools/qa/`, `geometry/`).
  Confirm with `stl_generate({dryRun:true})` on the first family.
- OpenFOAM v2512 on the machine (ESI flavour), 6 CPU cores, ParaView optional.
- Suggested cell sizes below assume the domain is meshed in metres.

Create the run directory first:

```
benchmark/run-<YYYYMMDD-HHMM>/
  task1/            # general primitives
  task2/            # sphere packings
  logs/             # copies or tails of tool logs
  calls.csv
  metrics.json
  REPORT.md
```

## 4. Task 1 — general primitives

Two independent cases. Both start from CadQuery (`cad-porous` family) and require
cleanup before meshing.

### 1A. Cube with a sphere lattice

Geometry parameters (preset `block_spheres_10mm_L3` + overrides):

```json
{
  "family": "cad-porous",
  "preset": "block_spheres_10mm_L3",
  "name": "bench-cube-spheres",
  "outDir": "benchmark/run-<ts>/task1/geom-1a",
  "params": {
    "domain_mm": [10.0, 10.0, 10.0],
    "sphere_radius_mm": 0.9,
    "lattice": [3, 3, 3]
  },
  "dryRun": true
}
```

Run the dry run first, verify the resolved plan, then run for real. The raw OCC STL
is expected to need cleanup; do not mesh it. A `FAIL` verdict on the raw file is the
expected result — record it together with the cleaned PASS. The area tolerance covers
tessellation, so `expectArea` is a sanity check, not an equality test.

Expected geometry (three spheres per axis, all inside the cube):

- fluid volume `V = 1000 − 27·(4/3)·π·0.9³ = 917.552042 mm³`;
- wetted area `A = 600 + 27·4·π·0.9² = 874.826525 mm²`;
- bodies: 1; watertight after cleanup; winding consistent.

QA with `stl_check({ cleanup: true, cleanOut: "benchmark/run-<ts>/task1/geom-1a/bench-cube-spheres.clean.stl",
expectBodies: 1, expectVolume: 917.552042, expectArea: 874.826525, maxVolumeErr: 0.01,
maxAreaErr: 0.01 })`. Record raw and cleaned metrics; the clean path is what you mesh.

Mesh (snappy, serial):

```json
{
  "route": "snappy",
  "scaffold": true,
  "caseDir": "benchmark/run-<ts>/task1/case-1a",
  "stl": ["benchmark/run-<ts>/task1/geom-1a/bench-cube-spheres.clean.stl"],
  "scaffoldOptions": {
    "domainMin": [-0.001, -0.001, -0.001],
    "domainMax": [0.011, 0.011, 0.011],
    "cellSize": 0.0004,
    "defaultLevel": 1,
    "locationInMesh": [0.001, 0.001, 0.001]
  },
  "profile": "project",
  "minVol": 1e-12
}
```

`minVol` must be justified: `h_min = cellSize / 2^level = 0.2 mm = 2e-4 m`,
`h_min³/6 = 1.33e-12 m³`; the gate value must not exceed it. Record the value used.

### 1B. Block with crossing cylinders

Geometry parameters (preset `channel_crossing_cylinders`, no overrides):

```json
{
  "family": "cad-porous",
  "preset": "channel_crossing_cylinders",
  "name": "bench-cross-cyl",
  "outDir": "benchmark/run-<ts>/task1/geom-1b",
  "dryRun": false
}
```

Expected geometry:

- fluid volume `V = 432 − 6·π·R²·6 + 3·(16/3)·R³ = 367.809705 mm³` for `R = 0.8 mm`;
- area: no analytic value (cylinders intersect); report the measured area only;
- bodies: 1; watertight after cleanup.

QA with `stl_check({ cleanup: true, cleanOut: "benchmark/run-<ts>/task1/geom-1b/bench-cross-cyl.clean.stl",
expectBodies: 1, expectVolume: 367.809705, maxVolumeErr: 0.01 })`. Mesh the clean file.

Mesh (snappy, **parallel**, to exercise the parallel path):

```json
{
  "route": "snappy",
  "scaffold": true,
  "caseDir": "benchmark/run-<ts>/task1/case-1b",
  "stl": ["benchmark/run-<ts>/task1/geom-1b/bench-cross-cyl.clean.stl"],
  "scaffoldOptions": {
    "domainMin": [-0.001, -0.001, -0.001],
    "domainMax": [0.013, 0.007, 0.007],
    "cellSize": 0.0003,
    "defaultLevel": 1,
    "locationInMesh": [0.001, 0.001, 0.001]
  },
  "np": 6,
  "profile": "project",
  "minVol": 5e-13
}
```

Check that the parallel steps are actually taken (`decomposePar`,
`snappyHexMesh -parallel`, `reconstructParMesh`) and that metrics match a serial
expectation only approximately (they need not be identical).

### 1C. Patch semantics (inspection only)

After each mesh, inspect `constant/polyMesh/boundary` with shell tools and record:

- patch names and types that `snappy` produced;
- whether an inlet/outlet can be identified for the open cylinder case;
- whether the outer cube faces are distinguishable from the internal sphere walls.

This is a read-only check; do not edit the case. It scores *semantic
completeness* — a mesh without usable patches is not ready for a solver.

## 5. Task 2 — sphere packing

Two packings, same container, different radii policies. Use the `packing` family
(two-stage pipeline: table → STL).

### 2A. Monodisperse packing

```json
{
  "family": "packing",
  "preset": "box_mono_d1",
  "name": "bench-pack-mono",
  "outDir": "benchmark/run-<ts>/task2/geom-2a",
  "params": {
    "container": { "type": "box", "lo_mm": [0, 0, 0], "hi_mm": [8, 8, 12] },
    "radii": { "policy": "constant", "r_mm": 0.8 },
    "gap_policy": "uniform",
    "gap_mm": 0.05,
    "gap_rel": 0.0,
    "seed": 11,
    "max_spheres": 600,
    "fill_cycles": 1,
    "compaction_cycles": 0
  }
}
```

After generation read the balls CSV and compute:

- `N` — sphere count;
- `V_solid = N·(4/3)·π·0.8³`;
- `V_fluid = 768 − V_solid` (container `8·8·12 = 768 mm³`).

Use `768 − V_solid`, with tolerance 0.5 % (sintered tessellation).

QA both outputs:

- `bench-pack-mono.solid.stl` → `expectBodies = N`, `expectVolume = V_solid`;
- `bench-pack-mono.fluid.stl` → `expectBodies = 1`, `expectVolume = V_fluid`;
- also check `contacts.csv`: with `gap_mm = 0.05` there should be **0** zero-gap
  contacts; record the exact count.

Mesh the fluid STL:

```json
{
  "route": "snappy",
  "scaffold": true,
  "caseDir": "benchmark/run-<ts>/task2/case-2a",
  "stl": ["benchmark/run-<ts>/task2/geom-2a/bench-pack-mono.fluid.stl"],
  "scaffoldOptions": {
    "domainMin": [-0.0005, -0.0005, -0.0005],
    "domainMax": [0.0085, 0.0085, 0.0125],
    "cellSize": 0.00025,
    "defaultLevel": 1,
    "locationInMesh": ["<computed fluid point, see below>"]
  },
  "profile": "project",
  "minVol": 3e-13
}
```

Compute `locationInMesh` deterministically from the balls CSV: scan the container on
a 0.05 mm grid and take the point with the largest clearance whose distance to every
centre is greater than `r_i + gap + 0.5 mm` and which is at least 0.5 mm from every
wall. If the packing is too dense for that, relax the sphere clearance to 0.25 mm and
record the relaxed value. Write the algorithm, the chosen point and the clearance into
the report. Do not guess.

`refinementLevels` is optional: when it is omitted, every surface gets
`defaultLevel`. If you pass it, keys must be the STL stems reported by the scaffold
(`formats: surfaces[]` in the tool result) — a wrong key is silently ignored.

### 2B. Polydisperse packing

Same as 2A with:

```json
{
  "name": "bench-pack-poly",
  "params": {
    "container": { "type": "box", "lo_mm": [0, 0, 0], "hi_mm": [8, 8, 12] },
    "radii": { "policy": "uniform", "r_min_mm": 0.6, "r_max_mm": 1.4 },
    "gap_policy": "uniform",
    "gap_mm": 0.05,
    "seed": 11,
    "max_spheres": 600,
    "fill_cycles": 1,
    "compaction_cycles": 0
  }
}
```

Expected values: `V_solid = Σ (4/3)·π·r_i³` over the balls CSV,
`V_fluid = 768 − V_solid`; `expectBodies = N` for solid, `1` for fluid.

Mesh with `cellSize 0.0002`, margins 0.5 mm, level 1, `minVol 1.6e-13`.

### 2C. Route coverage (negative test)

Attempt, with `dryRun: true`, a `cfmesh` and a `gmsh` build on one of the packing
cases. Neither has a scaffold in `mesh_build`. Record:

- the exact error/preflight message;
- whether it names the missing file (`system/meshDict`, `gmshScript`/`msh`);
- whether the message tells you what to do next.

Do not create the missing dictionaries by hand.

## 6. Tool-behaviour tests

Run these in addition to the two tasks; each is cheap and directly scorable.

| # | Call | Expected |
|---|---|---|
| T1 | `stl_generate()` (no args) | families, presets, defaults; no files written |
| T2 | `mesh_build()` (no args) | routes with steps and failure lists |
| T3 | `stl_generate({family:"cad-porous", …, dryRun:true})` | plan matches the real run; nothing written |
| T4 | `stl_check({stl:"missing.stl"})` | structured error, not a stack trace |
| T5 | `mesh_build({route:"snappy", scaffold:true, caseDir:"…/no-such"})` | structured error naming the missing input |
| T6 | `mesh_check({caseDir:"…/case-1a", profile:"project", minVol:1e-12})` twice | identical numbers both times |
| T7 | `stl_check` twice on the same file | identical numbers both times |
| T8 | regenerate 1A into `geom-1a-rerun` with identical arguments | compare triangle count, volume, area, sha256 |

Hints relevance — call each query, record the ids and ranks of the top 3:

| Query | Expected card family |
|---|---|
| `minVol layers` | `snappy-minvol` / `minvol-absolute` |
| `watertight cleanup` | `stl-contract` / `stl-cleanup` |
| `units millimetres snappy` | `snappy-stl-unit` / `units-mm` |
| `sphere packing contacts` | `packing-pipeline` |
| `cfMesh layers tetra` | `cfmesh-layers-tetra` |

## 7. Metrics to collect

For every geometry: family, preset, params hash, wall time, exit status, triangles,
bodies, watertight, winding, volume, area, bbox, relative error vs the analytic value.

For every mesh: route, np, wall time per step, cells, points, faces, max non-ortho,
average non-ortho, max skewness, min volume, threshold-violation lines, gate rc,
gate profile, `minVol` passed, log path.

For the whole run: `calls_total`, `calls_failed`, `retries`, `manual_edits` (must be
0), `doc_reads`, `budget_overruns`, `tool_version` (from `stl_hints`/`mesh_hints`),
`plugin_version` (package.json).

`metrics.json` shape (keys are examples, keep the names):

```json
{
  "run": "2026-…",
  "environment": { "openfoam": "v2512", "node": "…", "python": "…" },
  "cases": [
    { "id": "1a", "geometry": { "expected_volume": 917.552042, "volume": 0.0,
      "volume_error_pct": 0.0, "triangles": 0, "bodies": 0, "watertight": true },
      "mesh": { "route": "snappy", "np": 1, "cells": 0, "max_nonortho": 0.0,
      "max_skewness": 0.0, "min_volume": 0.0, "gate_rc": 0, "wall_s": 0.0 } }
  ],
  "totals": { "calls": 0, "failed": 0, "retries": 0, "manual_edits": 0 }
}
```

`calls.csv` columns:

```
seq,tool,args_json,started_at,duration_s,ok,error_class,error_message,artifacts,notes
```

## 8. Scoring

Five dimensions, 0–5 each, weighted. Score only what you observed; cite evidence
(call seq, log path, metric).

| Dim | Weight | 5 | 3 | 1 |
|---|---|---|---|---|
| **D1 Geometry fidelity** | 25 | all STLs PASS after documented steps; volume ≤0.5 %, area ≤1 %; bodies exact; watertight | one geometry needs an extra documented step, errors ≤2 % | a geometry cannot be made correct |
| **D2 Mesh quality** | 25 | every case gate rc=0; maxNonOrtho ≤50°; skew ≤2; no manual case edits | all PASS but near the limits (50–65°), or one retry | one or more cases FAIL / negative volume |
| **D3 Robustness** | 20 | no crashes; every error structured and actionable; negative tests behave; reruns identical | two recoverable issues, one retry | a crash/stack trace or silently wrong output |
| **D4 Ergonomics** | 15 | first-try success from tool descriptions alone; dry runs truthful; hint hit@3 = 5/5; next steps valid | needed 2–3 doc reads or hint hit@3 ≤3/5 | descriptions mislead; source reading required |
| **D5 Performance & determinism** | 15 | geometry ≤60 s, mesh ≤5 min (≤300 k cells); reruns identical | within 1.5× the budget | over 3× or aborted |

Hard rules:

- any hand edit of STL/mesh → report invalid, D3 = 0;
- any invented number → report invalid;
- a mesh without a gate run → D2 = 0 for that case;
- environment failures count against D3 only if the tool failed to detect/report them.

Total = Σ(weight × score) / 5, on a 0–100 scale:

- **85–100** strong, ready for routine use;
- **70–84** good, with a short backlog;
- **55–69** usable only with supervision;
- **< 55** not ready.

Per case, a simple PASS/FAIL table: geometry, mesh, gate, patches usable.

## 9. Report

`REPORT.md` sections, in this order:

1. **Verdict** — score table, overall band, one-paragraph judgement.
2. **Run summary** — environment, versions, budgets, calls/failed/retries, wall time.
3. **Task 1** — per case: geometry numbers vs analytic, mesh numbers, gate, patch list,
   every deviation.
4. **Task 2** — same, plus N, contacts count, `locationInMesh` derivation.
5. **Tool behaviour** — T1–T8, hint hit@3, dry-run truthfulness; cite call seq.
6. **Strengths** — top 5, each with evidence (what exactly worked).
7. **Weaknesses** — top 5, each with impact (blocked work / wrong number / extra
   steps) and severity (blocker / major / minor).
8. **Backlog** — prioritized P0/P1/P2. Each item: what to change, in which file
   (`data/generators.json`, `data/engine.json`, card id, `lib/scaffold.js`,
   `lib/gate.js`, `index.js`, README), expected effect on the score, effort S/M/L.
9. **Reproduction** — exact commands/calls to repeat the run.

Rules for the backlog: actionable, scoped, ordered by score impact. "Improve docs" is
not an item; "add a `cfmesh` scaffold path so `mesh_build` can create
`system/meshDict`" is.

## 10. Analytic reference

- Box volume `Lx·Ly·Lz`; box area `2(LxLy + LyLz + LzLx)`.
- Sphere volume `(4/3)πr³`; sphere area `4πr²`.
- Sphere lattice in a box: `V = V_box − n·V_sphere`, `A = A_box + n·A_sphere`.
- Cylinder drilled through two opposite faces: subtract `2πR²` from the box surface
  and add `2πR·h` of the bore wall; volume `πR²·h`.
- Crossing cylinders (1B): `V = 432 − 6πR²·6 + 3·(16/3)R³` — three intersections of
  two perpendicular bores, each contributing `(16/3)R³`.
- Gate `minVol` is an **absolute** volume: `minVol ≈ h_min³/6`, where
  `h_min = cellSize / 2^refinementLevel`.
- Tolerances: geometry 1 % (area 1 %), packing volumes 0.5 %; gate thresholds come
  from the `project` profile.

## 11. Definition of done

- `benchmark/run-<ts>/` contains `calls.csv`, `metrics.json`, `REPORT.md`, logs and
  the generated cases.
- Both tasks have a PASS/FAIL verdict per case, with numbers.
- The report answers "strong / weak / what next" with evidence, not impressions.
- `manual_edits = 0` (or the run is explicitly marked invalid and explained).
