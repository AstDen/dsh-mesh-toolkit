# dsh-mesh-toolkit

> **0.3.0** · Three packages for **DeepSeek Harness**: a shared core plus two
> host-only plugins distilled from the `Mesh_3D_pore_scale` project. Build a
> watertight STL, then turn it into a checked OpenFOAM mesh. Six tools, 32
> searchable knowledge cards per catalog, no build step.

| Package | Jobs | Tools |
|---|---|---|
| [`sim-core/`](sim-core/) | config layering, `sim-project.json`, path resolver, checkMesh parser, JS quality gate, passports, shared cards | library, no tools |
| [`mesh-stl/`](mesh-stl/) | STL families and portable primitives, contract QA, cleanup, passport row | `stl_hints` · `stl_generate` · `stl_check` |
| [`mesh-build/`](mesh-build/) | snappyHexMesh / cfMesh / gmsh route D, JS quality gate, mesh passport | `mesh_hints` · `mesh_build` · `mesh_check` |

Thin wrappers over the project's real generators and OpenFOAM binaries. No invented
metrics: every number comes from a real run, full logs stay on disk, the tool returns
a compact JSON summary. Plugins talk to each other through Cordis services
(`simHints`, `simGeometry`, `simMesh`), not through each other's files.

## Status

Validated on **OpenFOAM v2512** (ESI), **ParaView 6.2.1**, **gmsh 4.15.2**,
**CadQuery 2.8.0**, Node 24.

**6 tools · 32 cards per catalog · 2 skills · 3 services · smoke and live tested

## Install

Requirements: Node ≥ 20, DSH `>= 0.2.1-rc.5 < 0.3.0`, **`sim-core/` next to the
bundles** (relative import `../sim-core/...`), OpenFOAM v2512. A project checkout with
`.venv/` and `tools/qa/` is needed for project generator families and STL QA; the
`primitive` family and existing-case meshing work without it.

```json
{ "action": "install_bundle", "target": "/path/to/dsh-mesh-toolkit/mesh-stl" }
{ "action": "install_bundle", "target": "/path/to/dsh-mesh-toolkit/mesh-build" }
```

Keep the three directories as siblings — `sim-core` is a library, not a bundle, so
there is nothing to install for it. The installer adds a `link:` dependency to the
profile and enables the bundle.
After editing `index.js`, `lib/*` or `data/*.json`, reload with disable → enable —
a repeated `enabled: true` reports `changed: false` and does not re-import.

Disable with `set_plugin` `enabled: false`; remove with `remove_bundle` (bundle package name).

Smoke tests without a DSH host (need the project, or `MESH_*_PROJECT_ROOT`):

```bash
node mesh-stl/scripts/smoke.mjs
node mesh-build/scripts/smoke.mjs
```

## Configuration

A project is described by **`sim-project.json`** in its root (schema:
`sim-core/schemas/sim-project.schema.json`): `units`, `caseRoots`, `scratch`, `foam`,
`fluent`, `gate {engine, profile, profiles, minVol, script}`,
`geometry {registry, workRoot, scriptRoots}`, `cores`, `physics`. The resolver walks up
to 12 levels from the session cwd; without a profile both plugins still work from the
cwd, and `primitive` needs nothing at all.

Precedence: `sim-project.json` → `config` in `cordis.patch.yml` →
`~/.config/{mesh-stl,mesh-build}/config.json` (override with `MESH_STL_CONFIG` /
`MESH_BUILD_CONFIG`) → `MESH_STL_*` / `MESH_BUILD_*` environment variables.

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

**sim-core** — one implementation of everything both plugins share: layered config,
project profile, path resolver with `resolvedFrom`, process runner (`source bashrc` →
`set -u`), `checkMesh -meshQuality` parser, quality gate, artifact passports, knowledge
store. `meshQualityDict` is written with all 13 keys; the verdict comes from the log
text, because `checkMesh` exits 0 even on `Failed N mesh checks`.

**mesh-stl** — families `fcc-cell`, `channel-spheres`, `double-layer-burner`,
`packing`, `cad-porous`, plus portable `primitive` (box / sphere / cylinder written in
plain JS, no Python, no project data). `geometry.scriptRoots` keeps generators outside
the project; presets resolve from `@package/...`. `stl_generate` runs the real
generator and QA-verifies every output; `stl_check` cleans and registers.

**mesh-build** — routes `snappy`, `cfmesh`, `gmsh`, `check`; `mesh_build` with
`scaffold: true` writes a runnable snappy case plus `case-manifest.json`, otherwise
builds an existing case; after the gate it writes `mesh-passport.json` (route, cells,
regions, thresholds, sha256/size/mtime of the polyMesh). `mesh_check` reports
`PASS/FAIL/ERROR`, threshold violations and passport freshness.

**Skills** — `mesh-stl` and `mesh-build` load on demand and carry the order of work,
hard rules and extension instructions. **Cards** — 32 per catalog: own cards plus the
neighbour's, with shared snappy/plugin cards deduplicated.

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

- No solvers, no delivery bundle, no Fluent: meshing stops at a passing gate.
- The gate is JS (`sim-core/lib/gate.js`); `tools/qa/mesh_gate.sh` is kept only as a
  parity reference and `gate.engine: "script"` escape hatch.
- `mesh-passport.json` records what the gate saw; `mesh_check` compares size+mtime,
  then sha256, and reports `stale` instead of silently trusting an old verdict.
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
sim-core/                 shared library (not installed as a bundle)
  lib/config.js           layered config + sim-project.json discovery
  lib/project.js          profile normalisation, built-in gate profiles
  lib/paths.js            absolute → cwd → caseRoots → projectRoot resolver
  lib/process.js          source bashrc → set -u, runPython
  lib/hints.js            card store, simHints service
  lib/checkmesh.js        metrics, violations, verdict from log text
  lib/gate.js             full meshQualityDict, .mesh-gate overlay, PASS/FAIL/ERROR
  lib/passport.js         mesh-passport.json, case-manifest.json, freshness
  schemas/*.json          sim-project, mesh-passport, case-manifest, stl-passport
mesh-stl/                 STL plugin
  index.js                3 tools + skill + simGeometry service
  lib/                    facade config, hints, generators, primitives, registry
  data/generators.json    families and presets (incl. primitive)
  data/primitives/*.json  cube / sphere / cylinder presets
  data/hints/*.json       20 cards
  scripts/smoke.mjs
mesh-build/               meshing plugin
  index.js                3 tools + skill + simMesh service
  lib/                    facade config, routes, scaffold, gate adapter, patches
  data/engine.json        routes and quality profiles
  data/hints/*.json       22 cards
  scripts/smoke.mjs
```

## Provenance and license

Distilled from a pore-scale meshing project (OpenFOAM + ParaView); its thresholds
follow the project's ADRs and the `project` gate profile. No third-party code is
vendored. MIT — see [LICENSE](LICENSE).
