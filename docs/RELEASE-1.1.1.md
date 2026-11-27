# 1.1.1 — the gate measures what it claims to measure

Released 2026-11-27. A defect sprint on the quality gate: four items from
`AUDIT-implementation-map-2026-11-26.md` (D-6, D-7, D-10, D-1) are closed, each with a unit test and a
measured run.

## What changed

| Item | Before | Now |
|---|---|---|
| **D-6** `minVol` | an absolute value had to be right for every mesh; `null` in the profile meant `-1` and a disabled check | `minVol = h_min³/6` is derived from the case (`selection.cellSize_m / 2^maxLevel`, else `system/meshQualityDict`), and when the derived threshold flags healthy snappy boundary cells the gate makes **one measured tightening pass** at the reported suggestion (`minVolSource: "derived-then-tightened"`) |
| **D-7** layers | only `Added N out of M cells` was parsed, so face coverage never appeared | `parseCheckMesh` returns `layersFaces`; `parseLayerFaces()` reads `Extruding N out of M faces (P%)` from the snappy log; `mesh_check` returns `layers {faces, cells, required, status}` |
| **D-10** `minLayerCoverage` | present in every profile, read by nothing | `layerCoverageCheck()` enforces it: `disabled` / `no-faces` / `ok` / `below`, and `below` turns the verdict into `FAIL` with `failKind: "layers"` |
| **D-1** duplicate cards | ten ids existed in both `mesh-build` and `mesh-stl` | one owner per id; `check-catalogue` fails on a duplicate — 56 unique cards, `stl_hints` 12, `mesh_hints` 44 |

## Measured evidence

Layered 10 mm case (box with a 3.5 mm sphere removed, `layerSurfaces: ["cav"]`, `nLayers: 3`, profile `project`,
no `minVol` passed):

```
gate: PASS | minVol: 8.7e-13 | source: derived-then-tightened
      derivation: h_min = 0.001891891891891892 m / 2^2 (scaffold cellSize and refinement levels)
layers: { faces: { extruded: 2756, outOf: 2768, percent: 99.5665 }, required: 0.8, status: "ok" }

mesh_check on the same case (no minVol):
      PASS | minVol: 1e-14 | source: derived-case-meshQualityDict
      layers: { faces: { 2756/2768 = 99.5665 % }, required: 0.8, status: "ok" }

same mesh, coverage forced to 10 %:
      FAIL | failKind: layers | status: below
      layer coverage 10% < 80% (Extruding 100 out of 1000 faces); the gate profile asks for minLayerCoverage 0.8.
```

## Verification

| Check | Result |
|---|---|
| `node --test mesh-build/test/*.test.mjs` | 71 tests, 69 pass, 2 skipped (fixtures need `MESH_TUTORIALS_ROOT`) |
| new `mesh-build/test/gate-defects.test.mjs` | 4 / 4 — parse shapes for both layer lines, coverage statuses, derivation from handoff/scaffold and `null` without one, one owner per card id |
| `scripts/check-catalogue.mjs` | catalogue OK — 56 unique cards, 12 in `stl_hints` |
| `scripts/check-versions.mjs` | mesh-build 1.1.1 · mesh-stl 1.0.1 · sim-core 1.1.1 |
| `scripts/contract-test.mjs --no-mesh` | 30 / 30 |
| `scripts/doctor.mjs` / `scripts/demo.mjs` | READY 9/9·0·0 · DEMO OK |

## Compatibility

No tool name, argument or handoff field changed. `minVol` gains a source and the gate can now return a
different threshold than the profile says — recorded in `minVolSource`/`minVolDerivation`, which are new
informational fields. A project that wants the old strict behaviour should pass `minVol` explicitly.

## Known gaps (unchanged)

- Fluent never opened a delivered `.msh`; `org14` CHT is unverified; foamy tutorials that SIGFPE are out of scope.
- `tutorial.mjs list --build <id>` still needs a project with `sim-project.json`; pass an absolute bashrc instead.
- The workbench seam still reports `known-gap M3c` until the neighbouring plugin parses hyphenated patch names.
