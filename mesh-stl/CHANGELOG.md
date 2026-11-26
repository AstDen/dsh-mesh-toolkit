# Changelog

## 1.0.0 — 2026-11-26

First stable release of the STL half: nine generator families (FCC cell, channel with spheres, double-layer
burner, packings, CAD porous, primitives incl. cone/pipe/`parts[]`, stratified channel, blob foam, box array),
in-process JS QA with a python parity reference (15/15), the STL contract (watertight, winding, units mm) and
the geometry passport. Versioned together with `mesh-build` and `sim-core` from 1.0.0-rc.1 on.

## 1.0.0-rc.3 — 2026-11-26

Portable mode fix found by the clean-user acceptance:

- `outDir` was refused whenever `sim-project.json` was absent (`outDir must stay inside the project root : …`),
  because the guard compared against an empty `config.projectRoot`. The project root now falls back to
  `config.rootDir`/`cwd`, and the refusal names portable mode when it fires.

## 1.0.0-rc.2 — 2026-11-26

No functional change: the version moves with the toolkit so the three packages stay aligned.

## 1.0.0-rc.1 — 2026-11-26

Version aligned with the toolkit 1.0 release candidate (the three packages are versioned together from here on).
Functional content is 0.4.1: cone/pipe/`parts[]` primitives with analytic volumes, nine generator families
(python families packaged under `generators/`, JS built-ins `primitive`, `stratified-channel`, `box-array`),
in-process JS QA with `qa.engine: js|python` and 15/15 parity against the python reference.
No behaviour change relative to 0.4.1.

## 0.4.1 — 2026-11-26

- **plan A4 (workbench contract)**: the built-in `primitive` family gained `cone` (with an apex and a truncated
  form), `pipe` (hollow cylinder with annular caps) and a `parts[]` assembly — one STL with several closed shells.
  Every body or part accepts `translate_mm`, `rotate_deg` (degrees about the global X, then Y, then Z) and a
  uniform `scale`; `volume_mm3_theory` is the analytic sum.
- A pipe is not convex, so `lib/shapes.js` orients its surfaces against an expected direction (outer wall out,
  inner wall toward the axis, caps at -z/+z) instead of the whole-body `orientOutward`.
- New presets `cone_r3_apex_h10`, `cone_frustum_r3_r1_h10`, `pipe_r3_r2_h10`, `parts_cube_and_cylinder`.
- Refusals: `radius_inner_mm >= radius_outer_mm`, an empty `parts[]`, an unknown shape, a non-positive `scale`,
  a malformed `translate_mm`. Acceptance `experiments/_scratch/verify-a4.mjs` — 15/15, measured volumes within
  0.16 % of the analytic values and every output watertight with the expected shell count.

## 0.4.0 — 2026-11-26

- **plan A1 (workbench contract)**: contributes `generate`, `qa` and `hints` to the new `meshToolkit`
  service (`apiVersion: 1`), which the solver-side workbench resolves at call time. The package works
  exactly as before when the service is never requested, and the geometry half is available even when
  mesh-build is not installed.

## 0.3.6 — 2026-11-26

- `files` now includes `generators/`: without it `npm pack` lost the python generators, and the families
  `fcc-cell`, `channel-spheres`, `packing`, `cad-porous`, `blob-foam` crashed on `@package/generators/...`
  in the installed package.
- `scripts/qa-parity.mjs` now finds the python reference itself: `tools/qa/stl_qa.py`, then the bundled copy
  `generators/cad/py_qa.py` (or `MESH_STL_QA_SCRIPT`), so parity is checked both in a standalone
  package and in CI.
- `scripts/smoke.mjs` passes without `sim-project.json`: in portable mode it checks the defaults
  (`project: "defaults"`, `registry: stl/registry.csv`, QA engine `js`), and the dry-run is anchored on cwd.
- `engines.dsh` and the peer ranges are aligned to `>=0.2.2-rc.1 <0.3.0`; `repository` filled in.

## 0.3.5 — 2026-11-26

### Added
- **Portable mode (plan 1.4).** `stl_generate`/`stl_check` work without `sim-project.json`:
  `project: "defaults"`, `configured: false`, relative paths from the current directory, the registry
  `./stl/registry.csv` created on demand. The `requireProject` gate no longer blocks calls.
- Knowledge card `portable-setup`; a link to `mesh-build/docs/PORTABLE.md`.

### Verified
- In an empty directory: `stl_generate(primitive)` → `./stl/generated/primitive/…stl`, QA PASS (JS),
  `stl_check` PASS, then the full meshing/delivery chain (see mesh-build 0.5.3).

## 0.3.4 — 2026-11-26

- **The STL registry works without a project** (`lib/registry.js: registryFilePath`): a relative `registry`
  is resolved from the project root, and without a profile — from the current directory; an absolute path is also accepted.
  The file is created on demand with the header.
- **A read-only registry does not break the verdict**: if a write is impossible (EACCES, a foreign header), `stl_check`
  returns `registered: {ok:false, error, row}` and a warning in `next`, while the QA verdict stays
  the same (verified with `chmod a-w stl/registry.csv`).

## 0.3.3 — 2026-11-26

- **The generators moved into the package.** The family python scripts and their presets live in
  `generators/{pore_cell,packings,cad}/` and `generators/presets/<family>/`; `data/generators.json`
  references them via `@package/…`, so `stl_generate` works on another machine without the
  research `geometry/` tree. `cad-porous` no longer imports `tools.qa.stl_qa`:
  `generators/cad/py_qa.py` sits next to it (a copy of the reference for cleanup/QA inside the generator).
- **Script-tree modes.** `generators.root` (`sim-project.json` / `MESH_STL_GENERATORS_ROOT`):
  `package` (the default) or `project` — then the python families take `projectScript`/`projectPreset`
  (`geometry/pore_cell/...`), i.e. the research mode is preserved.
- **Two new built-in JS generators, with no python at all.** `stratified-channel` was rewritten in JS
  (`lib/generators/stratified.js`: two boxes of 12 triangles each, a shared emitter `lib/shapes.js`),
  and `box-array` was added (`lib/generators/box-array.js`: an `nx×ny×nz` lattice of spheres/cylinders →
  `<name>.solid.stl` + `<name>.container.stl`, with a warning on neighbour intersections).
- **A clear error instead of a traceback.** Before a python family the plugin checks
  `import trimesh, numpy` (and `cadquery`/`scipy`/`skimage` where needed) and returns
  `error: "python-bridge-missing"` with the exact `pip install` command, a hint about the JS families
  and the path to the interpreter.
- **Acceptance.** In an empty directory with a minimal `sim-project.json`, `primitive`,
  `stratified-channel` and `box-array` work (generation + JS QA), and then `mesh_build(snappy)`:
  box-array 10×10×20 mm, 16 spheres r=1.5 → 63 228 cells, gate PASS (maxNonOrtho 21.48, skew 0.304).
  The python families were checked on the packaged scripts: `channel_spheres_L3` gives fluid 8352 tri /
  162.7341 mm³ and `fluid_patches` 8352 tri (no tripling after DEF-01), `cad-porous` raw PASS 4950 tri.

## 0.3.2 — 2026-11-26

- **STL QA moved inside the plugin (JS, no python and no project).** `lib/qa/` is its own engine:
  `reader.js` (binary/ASCII STL, vertex welding to 8 significant digits like trimesh's `tol.merge`), `metrics.js`
  (watertight by "every edge in exactly 2 faces", normal consistency, bodies as edge-connected components
  sharing 2 faces, volume/area/bbox, degenerate and duplicate faces,
  non-manifold edges), `verdict.js` (the same texts and the same order of problems/warnings as
  `stl_qa.py`, including tolerances in python format) and `clean.js` (cleanup by trimesh's OBB rule —
  `height = 1e-8`, not by area: otherwise 1-µm slivers open the surface).
- **Parity with the reference.** `scripts/qa-parity.mjs` compares the JS engine and `tools/qa/stl_qa.py` on synthetic
  fixtures and on the project's real STLs: 15/15 matches, the only documented divergence being
  a thrice-duplicated ASCII facet (`fluid_patches.stl`), where trimesh welds vertices by the file's
  normal; the verdict, watertightness, duplicates, volume and area still match.
- **Engine selection.** `stl_check` accepts `engine: "js"` (the default, in-process, ~2 ms per cube) or
  `engine: "python"` (the reference); config `qaEngine` / `MESH_STL_QA_ENGINE`; on an exception in the JS engine
  an automatic fallback to python (`engine: "python-fallback"`) if the project script is available.
- **Speed and memory.** 862 898 triangles — 6.6 s / 846 MB, 1 471 974 — 11.9 s / 1.3 GB;
  the metrics match python to 1e-10 on volume, bodies and degenerate faces — exactly.

## 0.3.1 — 2026-11-26

- **Generator families**: added `stratified-channel` (two regions across a horizontal
  interface: `<name>.lower.stl` / `<name>.upper.stl`) and `blob-foam` (metaballs/marching cubes,
  porosity 0.45–0.80, presets `blob_foam_cube16_phi*`) — both available through `stl_generate`
  without code changes.
- **QA does not let a raw non-watertight STL through**: `stl_check` reports the number of non-manifold edges
  (`non_manifold_edges`, zero-thickness surface contact) and, without `cleanup:true`,
  gives FAIL with a pointer to cleanup (DEF-02/DEF-05: previously the verdict was built only on the cleaned mesh).


## 0.3.0 — 2026-11-25
Migration to the shared `plugins/sim-core` core and the project profile.

- **Core:** utilities, the process runner, the OpenFOAM environment, `sim-project.json` discovery, the path resolver,
  layered config, knowledge cards, the `checkMesh` parser, the quality gate and artefact passports now
  live in `sim-core`. `lib/common.js` is a facade, so two copies of the code no longer diverge.
- **Profile:** `sim-project.json` (units, caseRoots, scratch, foam, gate, geometry, cores) replaces
  binding to a specific project; without a profile the tools work from cwd, searching the path upwards for 12 levels.
- **Cards:** a shared `simHints` service — plugins register their own `data/hints`, and others' are not read by path.
- **`simGeometry` service:** generation/QA are available to the other plugins of the family (`simGeometry.generate/qa`).
- **Portable primitives:** the `primitive` family (box/sphere/cylinder) writes STL in pure JS,
  with no Python, CAD or project data — the meshing route can be run on any machine.
- **`geometry.scriptRoots`:** generators can be kept outside the project, the path is returned in `resolvedFrom`.
- **Neighbour's cards:** mesh-build exposes its snappy/gate cards through the shared service (instead of files).

## 0.2.0 — 2026-11-23
Fixes from the benchmark `benchmark/verify-20261123-1851`.

- **`expectBodies` is no longer checked by default:** `stl_qa.py` accepts `--expect-bodies`
  with the value `None` (the check is disabled), the tool description says "Omit to skip".
  `stl_generate` substitutes the shell count declared by the generator (`n_bodies`,
  `expected_bodies`, `fluid_out.n_bodies`) — so the `cad`/`packing` cases no longer "fail" on 28/15/16 bodies.
- **`maxVolumeErr`/`maxAreaErr` are percentages:** the descriptions were fixed (`1 = 1 %`), and for a value ≤0.05
  a warning about units is issued (the `stl_qa.py` CLI compares percentages).
- **One verdict per file:** `cleaned` is no longer re-checked by a separate call without expectations —
  `{file, cleanup}` from the same run is returned (`cleanup` — what exactly was removed).
- **Card `cadquery-cutting-traps`:** `cut(Compound)` loses the volume of the cavity intersection
  (407.872568 versus 410.603235 mm³ on the minimal test; −2.219 % on case 1B).
- **Neighbouring plugin's cards:** `stl_hints` sees the `mesh-build` plugin's `data/hints` (hit@3 = 5/5).
- **Version checked against disk:** `versionInfo()` → `{reported, onDisk, stale}`.
- Smoke tests extended with regressions for every item listed above.

## 0.1.1 — 2026-11-23
- Portability: machine absolute paths removed from the README/examples (installation and config — placeholders).
- The OpenFOAM environment is configurable: `openfoamRoots` / `MESH_STL_OPENFOAM_ROOTS` (the standard directories remain the default), an explicit `openfoamBashrc` still takes priority.
- Card `units-mm` refined: three places with units (blockMesh, geometry scale, locationsInMesh) and how the scaffold differs (metres).
- All numeric claims in the cards verified against `journal/` and `experiments/` (no discrepancies found).
- After a dry-run `stl_generate` hints at the real declared output (`<name>.raw.stl`) instead of the non-existent `<name>.stl`; `cleanup: true` added to `next`.

## 0.1.0 — 2026-11-23
- First version: three tools, JSON data (knowledge cards + family/route registry).
- Assembled from the project journal `experiments/exp-000…exp-018` and ADRs `D-001…D-019`.
- Smoke tests without DSH (`scripts/smoke.mjs`).
