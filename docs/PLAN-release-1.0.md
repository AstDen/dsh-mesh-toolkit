# Plan to release 1.0: clearing the three blockers

State as of 2026-11-26: code 0.5.1 is published (`master` = `d7ac1aa`, tag `v0.5.1`, the Release exists).
Below is what remains so that the toolkit can be installed on someone else's machine and linked to
`@yakovlev-i-a/dsh-openfoam-workbench` (0.9.20) without hand-editing paths.

Legend: ✅ done · 🟡 partial · ⬜ not started. Estimates are in agent-days for one agent.

---

## Blocker 1. Coupling to the research project (🟡 1–2 days: 1.1 and 1.2 done)

Outside `Mesh_3D_pore_scale` only the `primitive` family works right now: everything else runs into
`tools/qa/stl_qa.py`, `geometry/*.py`, `stl/registry.csv`, `caseRoots: experiments/...`.

### 1.1 STL QA inside the plugin (✅ done, 2026-11-26) — the main piece
Done in `mesh-stl/lib/qa/` (dependency-free ESM, no python and no project), package version 0.3.2:
- `reader.js` — binary and ASCII STL, `mergeVertices` over 8 digits (like trimesh's `tol.merge`); for ASCII
  — taking the file normal into account, the way the trimesh loader does; degenerate triangles are kept.
- `metrics.js` — watertight (every edge in exactly 2 faces), winding consistency (only edges
  with multiplicity 2), bodies = connected components over faces via such edges, volume by divergence,
  area, bbox, degenerate faces (area ≤ 1e-12), duplicates, non-manifold edges.
  Implementation — an open-addressing edge hash table (no allocation per edge).
- `verdict.js` — the same texts and the same order of `problems`/`warnings` as in `stl_qa.py`, including
  `|ΔV| = …% > tolerance 2.0%`, `volume <= 0 (…)`, the warning `bodies: N (expected M)` and
  the `raw STL is not watertight (…)` problem, which ends in `run --clean-out before meshing`,
  only when no cleanup was requested.
- `clean.js` — cleanup by the trimesh rule (`nondegenerate_faces(height=1e-8)`: minimum edge and
  minimum height > 1e-8), and **not** by area: the blob foam has 2 faces with an area of 1e-13 mm² —
  legitimate geometry; removing them opened the surface and produced a false FAIL.
- Engine selection: `stl_check(engine)` / `qaEngine` / `MESH_STL_QA_ENGINE`, default `js`;
  `python` is kept as the reference, and on an exception in JS there is an automatic `python-fallback`.

**Acceptance (facts):** `scripts/qa-parity.mjs --project` → **15/15 checks match**
`tools/qa/stl_qa.py` on synthetic fixtures (cube, degenerate faces, open box, touching cubes,
triple-duplicated ASCII) and on real STLs (A1, A2, E1 raw, C4 raw, fluid, patches):
verdict, `bodies`, volume/area (volume matches to 1e-10 relative), degenerate faces and duplicates.
The only documented discrepancy is `fluid_patches.stl`: trimesh merges the vertices of ASCII facets
by the file normal, so its `vertices_merged/non_manifold/euler` are lower (4592/12947/16701 versus
20880/22956/22980 for us), while the verdict, watertightness and volume match.
Speed/memory: 862 898 triangles — 6.6 s / 846 MB; 1 471 974 — 11.9 s / 1.3 GB.

### 1.2 Generators without the project (✅ done, 2026-11-26)
- The family Python scripts move **into the package**: `mesh-stl/generators/{pore_cell,cad,stratified}/…`
  (they currently live in the research `geometry/`). `generators.json` gains a `script` relative to
  `PACKAGE_ROOT`, and the mode `generators.root: "package" | "project"`.
- Simple families are rewritten in JS (no python at all): `primitive` (exists), `stratified-channel`
  (two boxes — 12 triangles per part), `box-array` (a lattice of spheres/cylinders as separate STLs).
- For the python families — a pre-check: `python3 -c "import trimesh, numpy"` → a comprehensible
  `python-bridge-missing` error with the install command, not a stack trace.
- **Acceptance:** in an empty directory with a minimal `sim-project.json`, `stl_generate` works for
  `primitive`, `stratified-channel`, `box-array`, plus `stl_check` + `mesh_build(snappy)`.

**Done (facts, 2026-11-26):**
- The Python scripts and helpers (`packing_lib.py`, `cq_common.py`, a copy of the `py_qa.py` reference)
  are in `mesh-stl/generators/{pore_cell,packings,cad}/`; presets are in
  `mesh-stl/generators/presets/<family>/` (30 files). `data/generators.json` references them via
  `@package/…`; the python families have `projectScript`/`projectPreset` for the
  `generators.root: "project"` mode.
- `generators.root` is parsed in `sim-core/schemas/sim-project.schema.json`; the config is read from
  `sim-project.json`, `MESH_STL_GENERATORS_ROOT`, default `package`.
- `stratified-channel` is rewritten in JS (`lib/generators/stratified.js`, two boxes of 12 triangles each),
  and `box-array` was added (`lib/generators/box-array.js`: a lattice of spheres/cylinders + container,
  with a warning about neighbours intersecting); the shared emitters are in `lib/shapes.js`.
- `python-bridge-missing`: `import trimesh, numpy` is checked before the run (+ `cadquery`/`scipy`/`skimage`
  per the `requires` field); the error contains the interpreter, the modules, the `pip install` command
  and a hint about the JS families.
- **Verified:** an empty `experiments/_scratch/accept-1.2` directory (only `sim-project.json`) —
  `primitive` 12 tri/1 body, `stratified-channel` 12+12 tri (800/1200 mm³), `box-array` 8448 tri / 16 bodies
  (QA PASS), then `mesh_build(snappy)`: 63 228 cells, gate PASS 21.48°/0.304; the packaged
  `channel_spheres_L3` — fluid 8352 tri / 162.7341 mm³, `fluid_patches` 8352 tri (the DEF-01 tripling
  did not come back); `cad-porous` raw PASS 4950 tri (the `py_qa` import works); `python-bridge-missing`
  is returned without a traceback.
- Regressions: `smoke.mjs` SMOKE OK, `qa-parity.mjs --project` 15/15.

### 1.3 STL registry and caseRoots (✅ done, 2026-11-26)
- `lib/registry.js: registryFilePath(config)` — a relative `registry` resolves from `projectRoot`, and
  without a profile from the current directory; an absolute path is accepted. The table is created on
  demand, together with its header.
- A read-only registry no longer breaks the verdict: `stl_check` returns `registered: {ok:false, error, row}`
  and a warning line in `next`. Verified with a live call on `chmod a-w stl/registry.csv` →
  `verdict PASS`, `registered.error = EACCES …`, the file was unchanged.
- `sim-core/lib/project.js`: case-local by default `caseRoots: ["./cases"]` (a profile overrides it);
  `mesh-build` DEFAULTS `caseRoot: "cases"`. Verified in an empty profile directory:
  `registry → ./stl/registry.csv`, `caseRoots ["./cases"] → <root>/cases`,
  `resolveProjectPath("exp-001/case") → <root>/cases/exp-001/case`.
- `fluid-point.py` moved to `plugins/mesh-build/scripts/fluid-point.py` (canonical), and a thin shim
  remains in `benchmark/scripts/fluid_point.py`; the messages in `precheck.js`/`index.js` point at the
  packaged script. Both entry points were run on real STLs (A1, box-array) — identical JSON.
- Versions: mesh-stl 0.3.4, mesh-build 0.5.2, sim-core 0.4.2. Regressions: both `smoke.mjs` SMOKE OK,
  `qa-parity.mjs --project` 15/15.

### 1.4 First run without the project (⬜ 0.5 day)
- `sim-core/lib/config.js`: when there is no `sim-project.json` — work on the defaults and return
  `project: "defaults"` in the responses; a separate hint card `portable-setup`.
- `mesh_hints`/`stl_hints` gain a card "working without the research project: what is available".
- **Blocker acceptance:** `docs/PORTABLE.md` + an end-to-end scenario in `experiments/portable-smoke/`
  (gitignored) that walks STL → snappy → gate → delivery in a clean directory.

---

## Blocker 2. Packaging and release engineering (✅ done, 2026-11-26)

Done in 0.5.1: a separate repository, tags, a GitHub Release, a CHANGELOG for all three packages.
Closed in 0.5.4 / 0.3.6 / 0.4.4:

### 2.1 CI (✅)
`.github/workflows/ci.yml`, node matrix 20/24, without OpenFOAM: `node --check` over `find` (not
`git ls-files`), `python3 -m compileall` over `mesh-stl/generators` and `benchmark/scripts`, `bash -n`
over the package shell scripts, both `smoke.mjs`, `scripts/check-catalogue.mjs` (21 + 24 cards,
35 unique after the merge, 10 shared — a report, not an error) and `scripts/check-versions.mjs`
(package.json == CHANGELOG == README banner, `engines`, licence, `repository`, `dsh.bundle.patch`),
`qa-parity.mjs` with `pip install trimesh numpy`, and a tarball completeness check
(`generators/`, `lib/qa/`, `scripts/deliver/`, `docs/`).

### 2.2 Publication (✅ decision: the git channel)
The channel is **git + `dsh plugin install_bundle` with an absolute path**, as for workbench
(`"private": true`), plus the `*.tgz` from the Release assets as the offline option. The reason for
rejecting npm: `mesh-stl`/`mesh-build` import the core by the relative path `../sim-core/lib/index.js`,
and the unscoped names on npm are taken; the move to npm is a separate task (scoped names + imports
`sim-core/lib/...`). Details and commands — `docs/PACKAGING.md`.
`files` was fixed: `mesh-stl` got `generators/` (otherwise the tarball shipped without the python
generators), `mesh-build` got `docs/` (the README links to `docs/PORTABLE.md`). Both defects are caught
by the new CI step.
`scripts/bump.mjs` — one command for three packages (patch/minor/major/an explicit version, `--packages`,
`--dry-run`, `--date`); it edits `package.json`, the CHANGELOG heading and the README banner, then runs
`check-versions`.

### 2.3 `engines.dsh` (✅)
Aligned to `">=0.2.2-rc.1 <0.3.0"` in all three packages (the field was added in `sim-core`), and the
`@deepseek-ai/dsh-*` peer ranges the same way. The upper bound `<0.3.0` is kept deliberately (a deviation
from the plan text): a DSH major may break the API, while workbench declares only the lower bound —
dropping the upper one only makes sense together with testing on 0.3.0.

### 2.4 Release workflow (✅)
`.github/workflows/release.yml` on a `v*` tag: the checks, `npm pack` of the three packages into `dist/`,
the body from `docs/RELEASE-<tag>.md` (otherwise a brief summary), `gh release create/upload` with
`GITHUB_TOKEN`, and the assets printed at the end. The manual API call from the 0.5.1/0.5.3 releases is
no longer needed.

## Blocker 3. Contract with workbench (⬜ 2–3 days)

Delivery is mesh-centric right now: `deliver/openfoam_<name>/` holds an empty `0/` and the mesher
dictionaries; the user creates the fields and the solver dictionaries by hand. Workbench
(`@yakovlev-i-a/dsh-openfoam-workbench` 0.9.20, `openfoam_case_scaffold`) can create them — an explicit
seam is required.

### 3.1 Contract document (⬜ 0.5 day)
`docs/WORKBENCH-CONTRACT.md`: who owns what.

| Stage | Owner | Tools |
|---|---|---|
| geometry → STL | mesh-toolkit | `stl_generate`, `stl_check` |
| STL → mesh, quality, passport | mesh-toolkit | `mesh_build`, `mesh_check` |
| patch types (inlet/outlet/wall/symmetry/cavity) | mesh-toolkit (new `mesh_patch_types`) | — |
| case delivery + handoff | mesh-toolkit | `mesh_deliver` + `handoff.json` |
| `0/` fields, `fvSchemes/fvSolution`, solver, post | workbench | `openfoam_case_scaffold`, `openfoam_check`, … |

### 3.2 `handoff.json` in the delivery (⬜ 0.5 day)
`mesh_deliver` writes next to `delivery_<name>.json`:
`{units, scale, regions[], patches[{name, type, role, nFaces, area_m3}], cells, gate, bbox_m,
suggestedFamily: "incompressible|compressible|cht", suggestedToolCalls: [{tool, args}]}`
(`role` is derived from the patch name and type; `suggestedToolCalls` is a ready-made
`openfoam_case_scaffold` call).
The schema is versioned (`handoffVersion: 1`).

### 3.3 `mesh_patch_types` (⬜ 1 day)
A new mesh-build tool: a `patches: {inlet: "patch", outlet: "patch", walls: "wall", ...}` config →
edits `constant/<region>/polyMesh/boundary` (in multi-region — every region), writes `.bak`, recomputes
`mesh-passport.json` (a `patchedBy` mark) and **does not** change the metrics.
Replaces the manual `foamDictionary -entry boundary.inlet.type -set patch` step from Appendix C.

### 3.4 Removing duplication (⬜ 0.5 day)
- In the README of both plugins: `mesh_build` is the main path, `openfoam_mesh_plan` is the fallback when
  mesh-toolkit is not installed or a "zero-config" setup is wanted.
- The `openfoam-meshing` skill (workbench) gains an opening section "if mesh-build is installed — use
  `mesh_build`/`mesh_check`" (an edit in the workbench repository, a separate PR).
- The `simMesh` service is described in the contract as the programmatic entry point for workbench.

### 3.5 End-to-end seam test (⬜ 0.5 day)
`scripts/contract-test.mjs`: A1m → `mesh_deliver` → `openfoam_case_scaffold` (workbench) →
a check of `0/`, `system/fvSchemes`, `openfoam_check` with no errors. In CI — `skip` without OpenFOAM.

---

## Order and milestones

| Milestone | Content | Outcome |
|---|---|---|
| M1 (days 1–4) | 1.1–1.4 | the toolkit installs into an empty directory, 3 families + snappy work — ✅ 2026-11-26 |
| M2 (days 5–6) | 2.1–2.4 | CI green, versions/CHANGELOG automated, the installation channel chosen — ✅ 2026-11-26 |
| M3 (days 7–9) | 3.1–3.5 | "mesh → solvable case" in 2 tool calls per the contract — 🟡 our half done (handoff, roles, revise, contract tier); the workbench half (Part B) is theirs |
| 1.0.0-rc.1 | M1+M2 + QUICKSTART/TROUBLESHOOTING | public pre-release — ✅ tagged 2026-11-26 |
| 1.0.0 (✅ tagged 2026-11-26) | + M3 + acceptance on someone else's machine | GA — accepted on a clean user (`docs/ACCEPTANCE.md`, two install channels); Part B stays with the workbench author |
| 1.1.0 | tutorial-2606 branch ported (plan S1: `mesh_tutorial`, capability matrix, `advanced` keys, `writeFields`, routes `ops`/`blockmesh`, 16 cards) | oracle evidence reproduced from the published tree (`docs/RELEASE-1.1.0.md`); defects D-1…D-10 stay scheduled for 1.1.1 / 1.2.0 |

## Risks

- **JS-QA parity with python**: compute volume/area the same way (divergence over triangles); a test on
  12 fixtures is mandatory, otherwise the verdicts will drift apart.
- **Python generators**: without python/numpy/trimesh 3 of the 6 families are unavailable — this must be
  in the README and in the tool error, not discovered halfway through.
- **Workbench version**: tie the contract to `>=0.9.20`; when workbench is absent, `handoff.json`
  remains a valid artefact.
- The **npm scope** `@astden` may be taken — reserve it before M2.

## Definition of done for 1.0

- [ ] In an empty directory: `stl_generate` → `stl_check` → `mesh_build` → `mesh_check` → `mesh_deliver`
      with no single path outside the working directory.
- [ ] CI green on two node versions, without OpenFOAM; the release workflow creates a Release from a tag.
- [ ] `handoff.json` + `mesh_patch_types`: after delivery `openfoam_case_scaffold` produces a working case
      without hand-editing `boundary`.
- [ ] Documentation: QUICKSTART, TROUBLESHOOTING (15 exact error strings), CONFIG, WORKBENCH-CONTRACT.
- [ ] Installation on a clean machine verified from the README by someone other than the author.
