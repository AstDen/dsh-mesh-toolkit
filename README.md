# dsh-mesh-toolkit

> **0.1.1** · Two host-only **DeepSeek Harness** plugins distilled from the
> `Mesh_3D_pore_scale` project: build a watertight STL, then turn it into a
> checked OpenFOAM mesh. Six tools, 41 verified knowledge cards, no build step.

| Plugin | Jobs | Tools |
|---|---|---|
| [`mesh-stl/`](mesh-stl/) | generate STL from verified families, contract QA, cleanup, passport row | `stl_hints` · `stl_generate` · `stl_check` |
| [`mesh-build/`](mesh-build/) | snappyHexMesh / cfMesh / gmsh route D, per-region quality gate | `mesh_hints` · `mesh_build` · `mesh_check` |

Thin wrappers over the project's real scripts (`geometry/**`, `tools/qa/stl_qa.py`,
`tools/qa/mesh_gate.sh`, `snappyHexMesh`, `cartesianMesh`, `gmshToFoam`). No
invented metrics: every number comes from a real run, full logs stay on disk, the
tool returns a compact JSON summary.

## Status

Validated on **OpenFOAM v2512** (ESI), **ParaView 6.2.1**, **gmsh 4.15.2**,
**CadQuery 2.8.0**, Node 24.

**6 tools · 41 cards · 2 skills · smoke tested · live session tested**

## Install

Requirements: Node ≥ 20, DSH `>= 0.2.1-rc.5 < 0.3.0`, the source project with its
`.venv/` and `tools/qa/`, OpenFOAM v2512.

```json
{ "action": "install_bundle", "target": "/path/to/dsh-mesh-toolkit/mesh-stl" }
{ "action": "install_bundle", "target": "/path/to/dsh-mesh-toolkit/mesh-build" }
```

The installer adds a `link:` dependency to the profile and enables the bundle.
After editing `index.js`, `lib/*` or `data/*.json`, reload with disable → enable —
a repeated `enabled: true` reports `changed: false` and does not re-import.

Disable with `set_plugin` `enabled: false`; remove with `remove_bundle` (bundle package name).

Smoke tests without a DSH host (need the project, or `MESH_*_PROJECT_ROOT`):

```bash
node mesh-stl/scripts/smoke.mjs
node mesh-build/scripts/smoke.mjs
```

## Configuration

Precedence: `config` in `cordis.patch.yml` → `~/.config/{mesh-stl,mesh-build}/config.json`
(override with `MESH_STL_CONFIG` / `MESH_BUILD_CONFIG`) → `MESH_STL_*` / `MESH_BUILD_*`
environment variables.

| Setting | Default | Meaning |
|---|---|---|
| `projectRoot` | auto-detect | walk up from the session cwd until `geometry/` + `tools/qa/` are found |
| `workRoot` | `stl/generated` / `.cache/mesh-build` | project-relative output root |
| `registry` | `stl/registry.csv` | STL passport |
| `caseRoot` | `experiments` | mesh-build case lookup root |
| `openfoamBashrc` | auto | explicit `etc/bashrc`; otherwise `openfoamRoots`, then `/usr/lib/openfoam`, `/opt/openfoam`, `~/openfoam` (newest wins) |
| `openfoamRoots` | `[]` | extra trees, `MESH_*_OPENFOAM_ROOTS` (colon-separated) |
| `python` | `<project>/.venv/bin/python` | interpreter for generators and gmsh |

No machine-specific paths ship in the repository — install targets, project roots and
OpenFOAM locations are placeholders. When the project cannot be found, a tool returns
`configured: false` with the exact setting to provide instead of throwing.

## What you get

**mesh-stl** — families `fcc-cell`, `channel-spheres`, `double-layer-burner`,
`packing`, `cad-porous`; presets from the project; `stl_generate` runs the real
generator and QA-verifies every output; `stl_check` also cleans and registers.

**mesh-build** — routes `snappy`, `cfmesh`, `gmsh`, `check`; `mesh_build` with
`scaffold: true` writes a runnable snappy case from an STL and a domain (metres),
otherwise builds an existing case; `mesh_check` runs `checkMesh` plus the strict
`tools/qa/mesh_gate.sh --profile project` for every region.

**Skills** — `mesh-stl` and `mesh-build` load on demand and carry the order of work,
hard rules and extension instructions. **Cards** — 19 + 22 searchable records, each
with statement, recipe, evidence and the metric it improves.

## Extending

Rule of thumb: **data first, code second**. Generators, cards, routes and thresholds
are JSON; new tools are plain `defineTool` registrations.

[docs/extending.md](docs/extending.md) — schemas, placeholders, step conditions,
profiles, scaffold options and the reload rule.

## Benchmark

Two reproducible tasks exercise the toolkit on generic primitives rather than project
data:

1. **Primitives** — a 10 mm cube with a 3×3×3 lattice of R=0.9 mm spheres (expected
   917.5520 mm³ / 874.8265 mm²) and a 12×6×6 mm block with six crossing R=0.8 mm
   cylinders (expected 367.8097 mm³), both meshed with snappyHexMesh.
2. **Sphere packing** — seeded monodisperse (R=0.8 mm) and polydisperse (0.6–1.4 mm)
   packings in an 8×8×12 mm box; both STL sets QA'd, the fluid volume meshed.

The task text, exact parameters, negative tests, scoring rubric (geometry 25 · mesh 25
· robustness 20 · ergonomics 15 · performance 15) and report template live in
[benchmark/PROMPT.md](benchmark/PROMPT.md). A run writes
`benchmark/run-<ts>/{calls.csv,metrics.json,REPORT.md}` and ends with a prioritized
P0/P1/P2 backlog.

## Limits

- No solvers, no delivery bundle, no Fluent: meshing stops at a passing `checkMesh`.
- Patch semantics are not assigned: CAD/STL surfaces become `wall`, so inlet/outlet
  types still need a manual `boundary` edit before a solver run.
- The gmsh route expects a ready OCC script and `.msh`; no gmsh scaffold is generated.
- `minVol` and `minTetQuality` are absolute volumes; pass `minVol` per mesh and record
  it in the run report.
- cfMesh layers over tetrahedra and `polyDualMesh` for CHT were rejected — see the
  `rejected-routes` and `cfmesh-layers-tetra` cards.

## Layout

```
README.md                 this file
benchmark/PROMPT.md       strict two-task evaluation protocol
docs/extending.md         data schemas, routes, thresholds, reload rule
mesh-stl/                 STL plugin
  index.js                3 tools + bundled skill
  lib/                    config, hints, generators, registry, skill
  data/generators.json    families and presets
  data/hints/*.json       19 cards
  scripts/smoke.mjs
mesh-build/               meshing plugin
  index.js                3 tools + bundled skill
  lib/                    config, routes, scaffold, gate, hints, skill
  data/engine.json        routes and quality profiles
  data/hints/*.json       22 cards
  scripts/smoke.mjs
```

## Provenance and license

Distilled from a pore-scale meshing project (OpenFOAM + ParaView); its thresholds
follow the project's ADRs and the `project` gate profile. No third-party code is
vendored. MIT — see [LICENSE](LICENSE).
