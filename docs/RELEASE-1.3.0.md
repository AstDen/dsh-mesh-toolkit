# mesh-toolkit 1.3.0 — the y+ formula, closed (audit D-5)

**Release date:** 2026-11-27 · packages: mesh-build 1.3.0 · mesh-stl 1.3.0 · sim-core 1.3.0

1.3.0 finishes the plan S3 defect sprint: D-5 was the last open item from
[`docs/PLAN-1.1.0-integration.md`](PLAN-1.1.0-integration.md) §S3. Nothing else changes: the tools, the gate,
the tutorial oracle and the delivery path are the same as 1.2.0.

## What changed

| | before 1.3.0 | now |
|---|---|---|
| first-layer height | `y⁺·ν/u_τ` was returned as the **cell height** | y⁺ is a centroid quantity: the cell is `2·y⁺·ν/u_τ`; `firstLayer_m` is the height, `wallDistance_m` the distance behind it |
| Reynolds regime | turbulent `Cf = 0.026·Re^(-1/7)` at every Re, with a note below 5e5 | `Cf = 0.664·Re^(-1/2)` (laminar Blasius) below Re 5e5, reported as `formula.cfModel: "laminar-blasius"` |
| clamp to the near-wall cell | none — a first cell taller than half the cell was returned and snappy extruded nothing | clamped to `0.5·cellSize`, `clamped: true`, the y⁺ actually obtained in `yPlusFirst` and a note saying what to do |
| inverse check | `yPlusFromThickness` reported the full-height y⁺ | `yPlus` is the centroid value (a round-trip returns the target), `yPlusCellHeight` the full-height one, `wallDistance_m` between them |
| migration | — | `legacyYPlus: true` on `mesh_first_layer` (or `changes.legacyYPlus` in a `mesh-feedback/1` document) reproduces the pre-1.3 numbers exactly |

Measured example (`uRef 10 m/s`, `lRef 1 m`, `nu 1.5e-5`, `yPlusTarget 1`, Re 666 667):
`Cf 0.00382812742`, `uTau 0.43750014 m/s`, wall distance **34.29 µm**, first cell **68.57 µm**, 22 layers.
The same input with `legacyYPlus: true` returns 34.29 µm — exactly half.

The revision ladder (`mesh_revise`, category `yplus`) uses the same corrected correlation, so a rebuild after a
run now targets the layer height the solver actually sees.

## Tests

| Check | Result |
|---|---|
| `node --test mesh-build/test/*.test.mjs` | **101 tests / 99 pass / 0 fail / 2 skipped** (2 need `MESH_TUTORIALS_ROOT` + `MESH_OPENFOAM_BASHRC`) |
| `test/firstlayer.test.mjs` | 8 cases: the ×2 factor, the legacy flag, the Blasius branch at Re 1e5, the `0.5·cellSize` clamp, the scaffoldOptions block, the inverse round-trip, invalid input |
| `node scripts/contract-test.mjs --no-mesh` | **30/30** (library + tools; the OpenFOAM and workbench tiers skip) |
| `node scripts/check-catalogue.mjs` | 67 cards in files / **57 unique** ids, one owner per id |
| `node scripts/check-versions.mjs` | 1.3.0 in the three trees, the root manifest and the README banner |

## Compatibility

- Tool names, arguments and result fields are unchanged **except** the y⁺ numbers and the four new result keys
  (`wallDistance_m`, `firstLayerRequested_m`, `clamped`, `formula`). Code that treats `firstLayer_m` as a
  distance from the wall should read `wallDistance_m` or pass `legacyYPlus: true`.
- `mesh-handoff/1`, `mesh-request/1` and `mesh-feedback/1` are unchanged; `changes.legacyYPlus` is an optional
  field, so older documents keep working.
- `minVol` behaviour from 1.1.1 and 1.2.0 is unchanged.

## Install

```bash
dsh plugin --profile web add "git+https://github.com/AstDen/dsh-mesh-toolkit.git#v1.3.0"
```

Plugin market index (pinned to the release commit):
`https://raw.githubusercontent.com/AstDen/dsh-mesh-toolkit/master/market/index.json` — add it under
**Plugins → Discover → Add index source**.

## Known gaps

- The ANSYS `.msh` is round-tripped through `fluent3DMeshToFoam` **and** was opened by Fluent 2026 R1 on
  2026-11-27 (148 288 cells, total volume 4.400032e-04 m³, minimum orthogonal quality 0.389, aspect ratio
  5.73, `check mesh` clean) — see `docs/ACCEPTANCE.md` § Fourth run. What is still missing is a *solver*
  run on that mesh, not the mesh itself.
- Multi-region CHT on OpenFOAM.org 14 is unverified (no `locationsInMesh` there).
- The solver-side workbench still truncates hyphenated patch names in its own `boundary` parser
  (`lib/of-engine.js:972`); our contract tier `M3c` reports it as a `known-gap`.
