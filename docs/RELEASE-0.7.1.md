# 0.7.1 — the workbench handoff, patch roles, the revision loop and y+ layers

Since 0.5.4 the three packages gained the workbench integration surface (plan A1–A5 in
`docs/PLAN-workbench-integration.md`) and two defects that had made layers unusable were fixed.

| Package | Version | Highlights |
|---|---|---|
| mesh-build | **0.7.1** | `mesh-handoff/1` written by `mesh_check`/`mesh_deliver`, `mesh_patch_types`, `mesh_revise`, `mesh_first_layer`, layer key fix, advice table as data |
| mesh-stl | **0.4.1** | cone/pipe primitives, `parts[]` composition with transforms and analytic volumes, `primitive-parts` card |
| sim-core | **0.5.1** | hint file dedupe and intent-first ranking, `handoff.js` + `toolkit.js` |

## The handoff (A1)

`mesh_check` and `mesh_deliver` now write `<caseDir>/handoff.json` (schema `mesh-handoff/1`): units and the
scale actually written in the case, bbox, cells/levels, gate verdict with metrics, patch names with contract
roles, STL provenance with sha256, and `next[]` — the ready tool calls that finish the job (for example
`mesh_patch_types` with `walls: [...]`). `mesh_deliver` puts the same file into the packaged
`openfoam_<name>/` case and records a `delivered` history event.

The optional `meshToolkit` service (apiVersion 1) aggregates `generate`, `mesh`, `patchTypes`, `gate`,
`deliver` and `revise`, answering `not-provided` for a half that is not installed. A consumer may use the
file alone — the contract is authoritative, the service only removes manual chaining.

## Patch roles (A2)

`mesh_patch_types` assigns solver roles (inlet/outlet/wall/symmetry/empty/interface) by retyping
`constant/<region>/polyMesh/boundary` — `.bak` backup, before/after diff, no face splitting. It refuses a
missing patch, a patch listed in two roles, a topological type (`empty`, `cyclic`), and a multi-region case
without `region`; `recheck:true` shows the gate verdict is unchanged. Roles survive later `mesh_check` runs.

## The revision loop (A3)

`mesh_revise` turns a `mesh-feedback/1` document into the next mesh: the reaction table lives in
`mesh-build/data/advice.json` (category → ladder of operations → ceiling), the rung is counted from the
revisions recorded in `handoff.json`, `apply:false` returns the plan, `apply:true` rebuilds with `mesh_build`
and re-runs `mesh_check`. After the ceiling the tool answers `{ok:false, escalated:true, options:[...]}`
instead of repeating parameters, and three consecutive `nonortho`/`skewness` failures switch the route
snappy → cfMesh.

Measured: a c2 case 66 241 → **122 977 cells** after a y+ revision, **9 600/9 600** boundary faces extruded,
gate PASS at 59.92°.

## Layers that actually extrude (0.7.0)

`snappyHexMeshDict` wrote `minMedianAxisAngle` — a key v2512 does not read — so every layered case stopped
with `FOAM FATAL IO ERROR: Entry 'minMedialAxisAngle' not found`. The key is now `minMedialAxisAngle`, and
`minTwist`/`minVolRatio` follow the gate profile instead of a hardcoded 65°/0.01.

## y+ → layers (A5)

`mesh_first_layer({uRef, lRef, nu, yPlusTarget, caseDir})` returns Re, Cf, u_τ, the flat-plate boundary-layer
thickness, the first-layer thickness, the layer count and a ready `scaffoldOptions` block; the inverse mode
takes a first-layer thickness and reports the y+ it gives. The scaffold writes `relativeSizes true`, so the
tool returns the **relative** final layer and needs the near-wall cell size — from `handoff.json` first, then
from `blockMeshDict` + `polyMesh/points` + snappy levels.

Measured: U = 10 m/s, L = 10 mm → Re 6666.7, first layer 24.67 µm, 9 layers, total 0.513 mm; rebuilding the
c2 case with that block adds **56 736 layers** over 86 400 boundary faces and keeps gate PASS at 59.97°.

## Cone, pipe and parts (A4, mesh-stl 0.4.1)

`primitive` accepts `cone` (frustum or apex), `pipe` (hollow, annular caps) and `parts[]` — a list of bodies
with `translate_mm`, `rotate_deg` (extrinsic X→Y→Z) and `scale`, merged into one STL with the analytic volume
reported. A `parts[]` STL is several shells, so `expectBodies` must be the shell count.

## Quality and docs

- 38 knowledge cards (`mesh_hints` merges both packages; `stl_hints` keeps its own 20).
- `scripts/check-catalogue.mjs` and `scripts/check-versions.mjs` gate the release; CI runs on node 20 and 24.
- Everything in this repository is English; only `*/locale/ru.json` carries Russian strings.

## Upgrading

```bash
dsh plugin install_bundle /path/to/dsh-mesh-toolkit   # or update the existing bundle
```

Then toggle both plugins once so the new modules are loaded:

```
plugin_manager set_plugin { target: "include:mesh-build", enabled: false }
plugin_manager set_plugin { target: "include:mesh-build", enabled: true }
```

A content change plus this toggle reloads the code without restarting DSH. A version bump alone does not
(the module cache keeps the old file until its content changes).
