# Integration plan: dsh-mesh-toolkit ↔ dsh-openfoam-workbench

Companion document to the normative [`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md). It contains an analysis
of the current workbench version, a comparison with our package, the methodology for porting what they have done
better, and a per-object work plan for both sides.

Analysis date: **2026-11-26**. Verified versions: workbench **0.9.22** installed / **0.9.23** in
upstream; mesh-toolkit **0.5.4 / 0.3.6 / 0.4.4** (mesh-build / mesh-stl / sim-core).

---

## 1. What was verified and where the facts come from

| Source | What it gave |
|---|---|
| `~/.dsh/profiles/web/node_modules/@yakovlev-i-a/dsh-openfoam-workbench` (0.9.22) | `package.json` (64 tools, 11 skills, Apache-2.0, `engines.dsh ">=0.2.2-rc.1"`), `lib/*.js` ≈6.2 thousand lines, `lib/tools/{env,case,run,build,mesh,render,papers,experience,meta}.js` |
| GitHub API `repos/yakovlev-i-a/dsh-openfoam-workbench` | tags `v0.9.23` (2026-11-26T07:31:04Z), `v0.9.22`, `v0.9.21`; description "63 tools, 11 skills"; README "v0.9.22 · 64 tools · 11 skills · 161 tests"; **v0.9.23 = write-gate hardening only** (curly braces in values, all `#` directives critical, the invariant of the number of `;`, argument whitelist, `clean(force:true)` via approval), 165 tests — the tool set and meshing did not change |
| `lib/meshlib.js`, `lib/tools/mesh.js`, `lib/tools/build.js`, `lib/registry.js`, `CORE.md`, `skills/*` | the actual behaviour of the primitives, `mesh_plan`, `mesh_verify`, `mesh_stl_check`, the y+ calculator, the capability matrix |
| `grep` over the installed package | workbench does **not** reference `dsh-mesh-toolkit`, does not call `ctx.provide(...)`; it reads services lazily (`ctx.get('approval')`) |
| DSH 0.2.2-rc.5 (`@deepseek-ai/dsh-tools`, Cordis) | `ToolsService.get(name, scope)` → a tool definition with `execute`; services are `ctx.provide` / `ctx.get` |
| our package (code + `benchmark/runs/20261125-1805/REPORT.md`) | 9 STL families, JS-QA with 15/15 parity, snappy/cfmesh/gmsh routes, quality gate, delivery, 35 cards |

The versions were not checked "from memory": the installed package was read, the tags and releases were obtained through the API,
the number of tools was taken from `package.json` (64) and cross-checked with the README.

---

## 2. Workbench geometry and meshing tools

| Tool | What it does | Remarks |
|---|---|---|
| `openfoam_stl_generate` | primitives **box / sphere / cylinder / cone / pipe**, `parts[]` with `translate`/`rotate_deg`/`scale` | the cone and the pipe are what we do not have; `parts[]` is composition without CAD |
| `openfoam_mesh_box_stl` | STL box of the outer domain | domain geometry, not physics |
| `openfoam_stl_inspect` | triangles, bbox, centroid, volume, area, watertight | watertight only up to 200 thousand triangles |
| `openfoam_stl_render` | PNG via pvpython | convenient for an eyeball check |
| `openfoam_geom_verify` | watertight / positive volume / bbox vs expectation | a checklist, without repair |
| `openfoam_compute_first_layer` | Re → Cf → u_τ → first-layer thickness, number of layers, total thickness | y+ → layers, absent in our package |
| `openfoam_mesh_plan` | domain `external` (3L/5L/3L/3L) / `internal` / `wrap` (default) / `box`, `target_cell_size` (default L/30) → `blockMeshDict` + `snappyHexMeshDict` + the feature dictionary per distribution | `needs_input` on unit suspicion (`scaleAskAbove` = 0.1 m); in `meshQualityControls` hardcoded `minVol 1e-13`, `maxNonOrtho 65`, `minTwist 0.02`; background `maxGlobalCells 8e6` |
| `openfoam_mesh_verify` | `checkMesh` per region, verdict from the "Mesh OK" line | strict thresholds are warnings only ("not a gate") |
| `openfoam_mesh_stl_check` | patch STL → bbox/area/volume + approximate Hausdorff | would have caught the geometry trimming (our DEF-11) |
| `openfoam_patch_diff`, `openfoam_dict_set`, `openfoam_check`, `openfoam_case_scaffold` | patch diff, dictionary editing, case "doctor", case scaffold (`incompressible`/`compressible`/`cht`) | `case_scaffold` reads the already existing `polyMesh/boundary` |

### 2.1. Instructions prescribed by them (skill `openfoam-meshing`)

The skill text sets a strict order and two rules that we do not have as explicit instructions:

```
1. stl_inspect          → triangles, bbox, watertight
2. stl_render           → check normals/closure by eye
3. compute_first_layer  → first-layer thickness from y+
4. mesh_plan            → domain.type required (external/internal/box), first_layer_thickness
5. blockMesh            → mesh_verify
6. snappyHexMesh        → mesh_verify
7. patch_diff           → inlet/outlet/walls are cut out
8. mesh_stl_check       → Hausdorff to the source STL
```

Rules from the Pitfalls section that are worth porting to us:

- "No `domain.type` → a wrong computational domain" — in our package `domain` is set by explicit `domainMin/Max`,
  so the error is impossible, but a "domain by type" is also unavailable (see A6).
- "After 3 failed snappy runs — downgrade: `strategy=coarsen` → `minimal` → `box_stl`" — a direct candidate
  for our `mesh_revise` revision table (category `nonortho`/`resolution`).

Comparison with our instructions (`plugins/mesh-stl/lib/skill.js`, `plugins/mesh-build/lib/skill.js`,
35 cards `data/hints/*.json`, `docs/PORTABLE.md`): we have a working order and hard rules
(STL in mm, `minVol ≈ h_min³/6`, the gate only through `mesh_check`, layers after castellation+snap,
`symmetry` on the domain planes), but we lack four steps that they have formalised as mandatory:

1. **the step "y+ → first layer"** before the mesh plan;
2. **the step "patch diff"** (`patch_diff`): check that inlet/outlet/walls are actually cut out;
3. **the step "mesh vs STL comparison"** (bbox/area/volume/Hausdorff);
4. **the downgrade rule** after a series of failures (instead of repeating the same settings).

These are exactly items A5, A7, A6 and rows 16/A3 in the tables below — that is, the instruction gap and
the code gap coincide, and they are closed by the same work items.


Strengths that we do not have or that are weaker in our package:

1. **Cone and pipe primitives** + `parts[]` composition with transformations.
2. **y+ → layers** as a separate calculation tied to the scaffold.
3. **Domain modes** with multipliers from the extent and `target_cell_size` → the background cell count.
4. **Unit suspicion** (`scaleAskAbove`) — it asks instead of continuing silently.
5. **Verification that the mesh matches the STL** (bbox/area/volume/Hausdorff).
6. **Capability matrix** per distribution, changing dictionary names and keys.
7. **Golden cases + docker CI** (cavity, sphereBox, sphereCht, pitzDaily) as a regression methodology.

What they lack and what remains our advantage: parametric porous families with presets,
JS-QA for STL with parity to python, cfMesh/gmsh routes, **a quality gate with profiles and an absolute `minVol`**,
a freshness passport, delivery (OF case + ANSYS `.msh` + report), 35 knowledge cards, a portable mode.

Separately: their `snappyHexMeshDict` hardcodes `minVol 1e-13` — on porous cells this is exactly the
trap because of which `minVol = h_min³/6` and the `minVolume/12` advice appeared in our benchmark.
Therefore we do not hand the "gate" over to them: they remain a consumer of our verdict.

---

## 3. Porting methodology (rule for choosing the method)

For every item from §2, **one** of three methods is chosen:

| Method | When | What we do |
|---|---|---|
| **R — re-implement** | the logic is short, the specification is known, the code is someone else's (Apache-2.0 versus our MIT) | we write our own from the specification, without copying; we close it with a test against a numerical reference |
| **C — contract** | the function is needed by both sides but lives on the boundary | we fix it in `WORKBENCH-CONTRACT.md` (schema/field/enum), implement it on our side, and workbench reads it |
| **L — leave** | the function belongs to the solver/physics | we do not touch it, we leave it to workbench; on our side — only receiving the result |

Rules mandatory for any method:

1. **No copying of workbench code**: Apache-2.0 is compatible with MIT, but requires preserving
   the notices; it is simpler and cleaner to implement the behaviour from the specification (all the necessary formulas and thresholds
   are fixed in §2 of this document).
2. **Test first, code second**: for every ported element — a numerical reference (for y+ —
   an example from their README/tests; for Hausdorff — a pair of STLs where the discrepancy is known in advance).
3. **Backward compatibility**: new fields are optional only; the existing tools and their
   responses do not change.
4. **Independence**: no port creates a mandatory dependency on workbench.

---

## 4. What we take and how

| # | Function | Method | Where | Estimate |
|---|---|---|---|---|
| 1 | Cone and pipe (outer/inner wall) | R | `mesh-stl/lib/shapes.js` + `primitive` | 0.5 d |
| 2 | `parts[]` with `translate`/`rotate_deg`/`scale` | R | same place, + parameter schema | 1 d |
| 3 | y+ → first layer/number of layers | R | new `mesh_layers` (mesh-build) + binding to `scaffoldOptions` | 0.5 d |
| 4 | Domain modes `external/internal/box/wrap` + `target_cell_size` | R | `mesh_build` scaffold (`domain.type`, `margins`, `targetCells`) | 1 d |
| 5 | Unit suspicion (`scaleAskAbove`) | R | `precheck.js` + the tool's `needs_input` response | 0.5 d |
| 6 | STL vs mesh (bbox/area/volume/Hausdorff) | R | new `mesh_surface_check` | 1.5 d |
| 7 | Capability matrix (dictionary names/keys) | R | `mesh-build/lib/caps.js`, used in the scaffold | 1 d |
| 8 | Golden case regression in CI | R (methodology) | CI: A1 cube 2584 cells, `mesh/a1` 32 718, E1 75 024 | 0.5 d |
| 9 | Patch role verification | C | `mesh_patch_types` + `handoff.patches[].role` | 1 d |
| 10 | The loop "diagnosis → revision → rebuild" | C | `mesh_revise` + `mesh-feedback/1` | 1.5 d |
| 11 | Case handoff | C | `handoff.json` in the delivery | 1 d |
| 12 | The `meshToolkit` service | C | `ctx.provide('meshToolkit', …)` | 1 d |
| 13 | Role and BC verification on the workbench side | L | stays with workbench | — |
| 14 | Solver launch, y+ from the results, convergence diagnosis | L | stays with workbench | — |
| 15 | Write/launch guard layer (whitelist, approvals) | L | we neither write `0/` nor launch the solver | — |
| 16 | Strategy downgrade after 3 failed snappy runs (`coarsen` → `minimal` → `box_stl`) | R | the `mesh_revise` revision table (data) | 0.5 d |

Total for part A ≈ **8–10 days** with tests and documentation.

---

## 5. Vision: "full partnership"

```
user ──task──► dsh-openfoam-workbench (physics, BC, targets)
                              │  MeshRequest
                              ▼
                    dsh-mesh-toolkit (geometry → mesh → gate → delivery)
                              │  handoff.json + case
                              ▼
                    dsh-openfoam-workbench (scaffold, openfoam_check, a short run)
                              │  MeshFeedback (y+, non-ortho, patch roles, resolution…)
                              ▼
                    dsh-mesh-toolkit (mesh_revise: deterministic revision table)
                              │  attempt += 1, a new handoff.json
                              └────────► repeat until PASS or the attempt limit → escalation
```

Key principles:

- **Roles are not blurred**: the mesh and its quality are ours; the physics, the solver dictionaries and the run are theirs.
- **Everything is reproducible through files**: `handoff.json` + the case on disk; the service only accelerates.
- **The loop is bounded**: `attempt` (3 by default, 8 maximum) and the revision table are deterministic,
  without "clever" guesses; when exhausted — 2–4 options to the user with the cost and the effect.
- **Both sides are self-sufficient**: workbench without us works with its own `mesh_plan` + `mesh_verify`;
  we, without workbench, deliver a case that opens in ParaView and in Fluent.

---

## 6. Part A — work in dsh-mesh-toolkit

### A1. `handoff.json` in the delivery (C) — ✅ done, 2026-11-26 (0.6.0)

- Writer and readers: `sim-core/lib/handoff.js` — `buildHandoff`, `writeHandoff`, `readHandoff`,
  `validateHandoff`, plus `scaleFromBlockMeshDict` (snappy `geometry.scale` first, then `blockMeshDict`),
  `domainFromCase` (bbox from `constant/polyMesh/points`, `hex` cells, `refinementSurfaces` levels,
  `locationInMesh`), `stlProvenance` (sha256/bytes), `qualityFromGate`, `patchRole`/`roleSummary`.
- Written by `mesh_check` (`<caseDir>/handoff.json`) and by `mesh_deliver` into the packaged
  `openfoam_<name>/` case (with `files.delivery` and a `history[]` event); the source case is updated too.
- Roles come from the patch type first and the name only refines `unknown` (`inlet|outlet|wall|symmetry|
  cyclic|empty|interface|wedge|unknown`); `next[]` carries the ready `mesh_patch_types` call while inlet/outlet
  are missing (A2 executes it: `mesh_patch_types`, shipped in 0.6.1).
- `meshToolkit` service (`apiVersion: 1`, `sim-core/lib/toolkit.js`) registered by both packages:
  `generate`/`qa`/`hints` from mesh-stl, `mesh`/`gate`/`deliver`/`hints` from mesh-build; absent methods answer
  `{ok:false, error:'not-provided', available, hint}`.
- Acceptance measured on `benchmark/runs/20261125-1805/mesh/a1` (fresh node, both plugins applied without DSH):
  `21/21` checks — handoff valid, `quality.verdict PASS`, `units.scale 0.001` from
  `system/snappyHexMeshDict`, bbox `[-0.002,-0.002,-0.002]…[0.012,0.012,0.012]`, cells `[20,20,20]`, level
  `a1-cube (2 2)`, patches `world:symmetry`, `a1-cube:wall`, `next[]` = `mesh_patch_types` with
  `walls:["a1-cube"]`, STL sha256 present, delivery copies the handoff and records the `delivered` event.

### A2. `mesh_patch_types` (C) — ✅ done, 2026-11-26 (mesh-build 0.6.1)

- Input: `caseDir`, `roles: {inlet: [names], outlet: [...], walls: [...], symmetry: [...], interface: [...]}`,
  `regions?`, `profile?` (re-check of the gate after the edit), `dryRun`.
- Edits only `constant/<region>/polyMesh/boundary` (a `.bak` backup), returns the diff
  `{before: {name: type}, after: …}` and the updated handoff.
- Refusal if the role and the type are incompatible (`inlet` on `symmetry`), if the patch is not found, if the case is
  multi-region and the region is not specified.
- Acceptance: B1 case `fluid` (one `wall` patch with 56 560 faces) → the inlet/outlet/walls roles are assigned,
  a repeated `mesh_check` gives the same metrics (the gate does not depend on patch types).

**Сделано (факты).** `plugins/mesh-build/lib/patchtypes.js` (parse/plan/apply) + tool `mesh_patch_types`
(`caseDir`, `roles` incl. plural aliases, `region`, `dryRun`, `recheck`, `profile`, `minVol`). It rewrites only the
`type` line inside each named patch, keeps `<boundary>.bak`, returns `{before, after, changes}` and regenerates
`handoff.json`; roles that the boundary file cannot express (inlet and outlet are both type `patch`) are stored in
the handoff and carried forward by `mesh_check`. Refusals: `patch-not-found` (lists the available `name (type)`),
`role-conflict`, `incompatible-type` (empty/cyclic/cyclicAMI), `needs-manual-setup` (cyclic/wedge),
`ambiguous-region` (multi-region without `region`), and a split of one patch into inlet+outlet (needs
`topoSet`+`createPatch`). Measured on `benchmark/runs/20261125-1805/mesh/c2` (fresh node): `18/18` checks in
`experiments/_scratch/verify-a2.mjs` — dryRun plans `world symmetry→patch` without writing; apply writes the file
and a `.bak`; the second pass reaches `flowReady` and empties `next[]`; `recheck` returns PASS with
`sameAsRecorded: true` (66 241 cells, 24.2346°, minVolume 1.52824e-11); all refusals produce their codes; the
multi-region case is refused without `region` and planned with `region:"fluid"`; `meshToolkit.patchTypes` resolves.
New knowledge card `patch-roles`; the bundled skill lists the tool. Acceptance for B1 (`fluid`, single `wall`
patch) follows the same path — the case is meshed, not yet retyped in the benchmark run (Appendix C was the manual
step this tool replaces).

### A3. `mesh_revise` (C) — ✅ done, 2026-11-26 (mesh-build 0.7.0)

- Input: `mesh-feedback/1`; output: `{ok, attempt, changes[], handoff, caseDir}`.
- The revision table is **data** (`plugins/mesh-build/data/advice.json`), not code: category → parameter →
  coefficient/step → iteration ceiling (see contract §3.3).
- In practice: `mesh_revise` converts the feedback into a partial `MeshRequest` (overrides of sizing/layers/
  domain/route/patches) and calls `mesh_build` + `mesh_check` (+ `mesh_patch_types` if the category is
  `patch-roles`).
- Acceptance: a deliberately spoiled y+ (layers disabled) → feedback(`yplus`) → T2 passes in ≤2 attempts.
**Сделано (факты).** `plugins/mesh-build/data/advice.json` — таблица как данные: 10 категорий, лестницы, потолки,
`routeDowngrade` (3 подряд `nonortho`/`skewness` → один snappy→cfmesh). `plugins/mesh-build/lib/revise.js` —
валидация `mesh-feedback/1`, `firstLayerFromYPlus` (Cf=0.026·Re^(-1/7)), `attemptState` по истории, `planRevision`
(rung = число прошлых ревизий категории; при потолке — `{ok:false, escalated:true, options[]}`).
Инструмент `mesh_revise`: `apply:false` план, `apply:true` пересборка `mesh_build` → `mesh_check` → запись
`{attempt, category, strategy, changes, verdict}` в `history[]`; `patch-roles` идёт через `mesh_patch_types`,
`stl-quality` останавливается на `stl_check`+cleanup. Приёмка `experiments/_scratch/verify-a3.mjs` — **21/21**:
y+ фидбек (y+=1 при U=10 м/с, L=0.01 м) пересобрал слойную сетку 66 241 → 122 977 ячеек, **9 600/9 600** граней
экструдировано, гейт PASS на minVol уровня первого слоя; три подряд `nonortho` переключают маршрут на cfmesh;
все отказы (units без scale, yplus без uRef/lRef, схема, потолок) ведут себя как описано. Попутно исправлен
`minMedianAxisAngle` → `minMedialAxisAngle` (слои в v2512 вообще не работали) и в словарь проброшен `expansionRatio`.

- A separate rule: after 3 consecutive failed builds with `nonortho`/`skewness` the table switches
  the route to a more robust one (snappy → cfmesh) instead of repeating the same parameters: this is a cheap
  insurance against an "infinite" loop, and it is also fixed in their skill.

### A4. The `cone`/`pipe` primitives and `parts[]` (R)

- `shapes.js`: `coneTriangles(r, h, sections)`, `pipeTriangles(rOuter, rInner, h, sections)`
  (the inner wall + two annular bands), `composeTriangles(parts)` with `translate`/`rotateDeg`/`scale`.
- The `primitive` family: `shape: cone|pipe`, `parts: [{shape, params, translate, rotate_deg, scale}]`.
- Tests: cone volume `πr²h/3` ±2 %, pipe `π(r_o²−r_i²)h` ±2 %, watertight for `parts[]`.

### A5. y+ → layers (R)

- A new `mesh_layers` tool (`U_ref`, `L_ref`, `nu`, `yPlusTarget`, `expansionRatio`, `coverage`)
  → `{Re, Cf, uTau, delta, first_layer_m, n_layers, total_m}`.
- `mesh_build` accepts `scaffoldOptions.layers: {mode: "yplus", yPlusTarget, U_ref, L_ref, nu}` and
  substitutes `nSurfaceLayers`/`firstLayerThickness`/`expansionRatio` (at present the layers are set manually).
- Acceptance: the reference from their test (U=10, L=0.1, ν=1.5e-5, y+=1) — the numbers match to within 1e-6
  relative to their formula.

### A6. Domain and scale (R)

- `scaffoldOptions.domain: {type: "external|internal|box|wrap", margins: {upstream, downstream, lateral,
  vertical_top, vertical_bottom}, sizeFactor}`; `external` — multipliers from `L = max extent`.
- `targetCells`/`cellSize`/`cells`: with `targetCells`, choose `cells` from the domain extent.
- `precheck.js`: `scaleSuspicion(bboxMm, {askAbove: 100 mm})` → the response `{needs_input: [mm|m]}` instead of
  a silent trimming.
- Acceptance: C1 sphere (domain 40×20×20 mm, 0.5 mm) → `cells [40,20,20]` from `cellSize 5e-4` and
  `targetCells ≈ 16 000` gives the same result; STL in metres → `needs_input`.

### A7. `mesh_surface_check` (R)

- Input: `caseDir`, `stl` (the reference), `patches`, `tol` (0.05 by default).
- `surfaceMeshTriangulate -patches …` → STL, then bbox/area/volume + approximate Hausdorff
  (sampling of the reference centroids, `closestPtTriangle`).
- Acceptance: E1 with a trimmed domain (our DEF-11) → FAIL with `bboxRel ≈ 0.5`; A1 → PASS.

### A8. Capability matrix (R)

- `plugins/mesh-build/lib/caps.js`: determine the distribution/version and the key set from the `bashrc`
  (`scale` vs `convertToMeters`, `surfaceFeaturesDict` vs `surfaceFeatureExtractDict`,
  the solver dictionary names, the presence of `cartesianMesh`) — at present this is smeared across the code.
- Use it in `scaffold.js` and in the route descriptions; expose it in `mesh_build` as `caps`.

### A9. Service and tests (C)

- `plugins/mesh-build/lib/service.js`: `ctx.provide('meshToolkit', {apiVersion: 1, capabilities, generate,
  mesh, revise, patchTypes, gate, deliver})`, registration in `apply(ctx)`; errors are structured.
- `scripts/contract-test.mjs` (in the repository): a dummy "workbench" on a fake ctx runs T1, T3, T5
  and checks that everything works without the service.
- CI: golden case regression (A1 2584, `mesh/a1` 32 718, E1 75 024 with a ±1 % tolerance), plus new tests A2–A7.

---

## 7. Part B — work in dsh-openfoam-workbench (for the author)

1. **B1. Provider discovery.** `const mesh = ctx.get('meshToolkit')` at call time, a check of
   `apiVersion === 1`, if absent — the ordinary path (`openfoam_mesh_plan` + `openfoam_mesh_verify`) and
   a mark in the report `mesh.provider: "workbench-fallback"`.
2. **B2. `openfoam_mesh_request`.** Assembles `mesh-request/1` from the physics (y+ via
   `openfoam_compute_first_layer`, the domain, `targetCells`), calls `mesh.mesh(request)` or the fallback;
   returns `{caseDir, handoff, verdict}`.
3. **B3. `openfoam_mesh_feedback`.** Packs the diagnosis into `mesh-feedback/1` (the category from the enum,
   evidence — log lines and metrics), calls `mesh.revise(feedback)`, returns `changes[]` and a new handoff.
4. **B4. Consuming `handoff.json`.** `openfoam_case_scaffold` on the delivered case: the patch roles
   are taken from the handoff (not guessed by name), before writing the BC — a check that all roles are known;
   otherwise `needs_input`/`mesh_patch_types`. The field `provenance: "mesh-toolkit@0.6.x"` in the case report.
5. **B5. Diagnosis after the run.** Mapping of failures (non-ortho warnings, y+ out of range,
   "bounding box"/`patch` mismatches) to feedback categories with evidence; y+ — from the `yPlus` function object
   or `openfoam_field_stats`, if the field is absent — `minor` with a hint to add it.
6. **B6. Deduplication.** When the provider is present, `openfoam_mesh_plan` is not called for the same case;
   the priority and the ban on double assembly are described in their README/skill.
7. **B7. Tests and independence.** Contract tests T1–T6 in their CI with a dummy provider; the golden
   matrix without the provider stays green; the optional peer `dsh-mesh-toolkit` in `package.json`
   (not installed automatically).

---

### 7.1. Questions to the workbench author (for critique and decision)

These items are not requirements but places where your choice is needed; they affect the contract
[`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md) and part A on our side.

1. **Patch roles.** Do you agree to read `handoff.patches[].role` in `openfoam_case_scaffold`
   instead of a heuristic by name (`inlet`/`outlet`/`walls`)? If yes — who owns the retyping:
   us (`mesh_patch_types`) or you (`openfoam_dict_set` with a record in the report)?
2. **Delegating `mesh_plan`.** Are you ready to add a provider mode: when the service
   `meshToolkit` (or the file `handoff.json`) is present, `openfoam_mesh_plan` does not write its own dictionaries but calls
   `mesh.mesh(request)`; fallback — the current behaviour? This removes double assembly.
3. **Service vs tools.** Is it more convenient for you to use the Cordis service `meshToolkit` (`ctx.get`) or to call our
   tools through `ToolsService.get('mesh_build')`? We can provide both, but we want
   to fix a single main path.
4. **Units.** Your `scaleAskAbove` (0.1 m) — should it be moved to `sim-project.json` as a shared parameter
   and fixed in `handoff.units.scale`? We already have a portable profile without `sim-project.json`.
5. **Feedback categories.** Is the enum `yplus|nonortho|skewness|patch-roles|resolution|
   domain|units|layers|cells-budget|stl-quality` sufficient, or are yours needed (`solver-divergence`, `boundedness`)?
   We are ready to extend the revision table with data.
6. **Golden cases.** Can an optional step "mesh-toolkit connected" be added to your CI (our
   `mesh_build` + `mesh_check` on your cavity/sphereBox), so that the contract regression runs on your side?
7. **Licences.** We implement the behaviour from the specification (y+, Hausdorff, domain modes) without
   copying code: Apache-2.0 → MIT-compatible, but this is simpler. Any objections?
8. **Naming.** `handoff.json` in the case root — does it conflict with your artefacts
   (for example, if `deliver/` is already taken)? We can put it in `deliver/handoff.json`.

## 8. Part C — the shared contract

Already fixed in [`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md): three schemas (`mesh-request/1`,
`mesh-handoff/1`, `mesh-feedback/1`), the patch role enum, the unit policy, the loop with `attempt` and the
revision table, the service API, compatibility rules, acceptance tests T1–T6, explicit non-goals.

What has to be done for part C: place the JSON schemas in `mesh-toolkit/schemas/` (on our side) and in
`dsh-openfoam-workbench/schemas/` (on the author's side), add a "schema ↔ handoff example" test to both sides,
and synchronise the contract version on changes.

---

## 9. Independence and compatibility

- **No hard dependency**: mesh-toolkit does not import workbench and does not require it; workbench
  works without mesh-toolkit (fallback + its own golden matrix).
- **No auto-installation**: only an optional peer and "how to enable" documentation.
- **The file contract is self-sufficient**: `handoff.json` + the case can be read by a human and by any other
  tool; the service is an accelerator.
- **Other tools**: `dsh-ansys-fluent-workbench` (future) reads the same handoff and the `.msh` from
  the delivery — the contract describes patch roles, not solver field names.
- **Manual mode**: the user can call `mesh_build`/`mesh_check`/`mesh_deliver` directly and
  hand the case over to workbench by hand — this is the same path as through the service.

---

## 10. Milestones and estimate

| Milestone | Content | Days |
|---|---|---|
| M1 | A1 handoff + A9 service (skeleton) + schemas | 2 |
| M2 | A2 `mesh_patch_types` (✅ 0.6.1) + A3 `mesh_revise` (revision table) | 2 |
| M3 | A4 primitives + A5 y+ + A6 domain/scale | 2 |
| M4 | A7 `mesh_surface_check` + A8 caps + tests/CI | 2 |
| M5 | joint T1–T5 with the workbench author | 1–2 |
| B | part B on the workbench author's side | 4–5 |
| C | schemas and synchronisation | 1–2 |

Result: **mesh-toolkit 1.0-rc** after M4, **1.0** — after green T1–T5 and installation by someone other than the author.

---

## 11. Risks and how we remove them

| Risk | Mitigation |
|---|---|
| Divergence of handoff interpretations | JSON schemas + a "schema ↔ example" test in both CIs; the contract version in the handoff |
| A long `mesh()` and timeouts | `caseDir` is preserved, status in the logs, a timeout = `blocked`, a retry with `attempt+1` |
| Double assembly (our snappy vs their `mesh_plan`) | B6: provider priority, a ban on a second pass for the same case |
| Licences (Apache-2.0 versus MIT) | re-implement from the specification only, without copying code |
| Different DSH/OpenFOAM versions | `apiVersion` + the capability matrix; on a mismatch — a clear refusal, not silent degradation |
| A false gate "PASS" | the gate stays ours; workbench does not override the verdict, it only asks for a revision |
| The temptation of "clever" revisions in the loop | the revision table is data with iteration ceilings; every change goes into `changes[]` |

---

## 12. What we consider done

1. `mesh_check` writes a `handoff.json` that is valid against the schema, with patch roles and `next[]`.
2. `mesh_patch_types` and `mesh_revise` pass their acceptance on real benchmark cases.
3. The `meshToolkit` service responds in the fake-ctx test; the errors are structured.
4. T1 and T3 are passed without workbench (on our side) and with a dummy provider (on theirs).
5. Documentation: `WORKBENCH-CONTRACT.md` + this plan + the "Portable mode" section/README without
   promises that the code does not keep.
