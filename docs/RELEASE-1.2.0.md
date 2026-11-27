# 1.2.0 — the second half of the S3 defect sprint

`1.2.0` finishes the defects the 1.1.0 audit recorded, and fixes a gate rule that a real meshed cube
exposed while the sprint was running. Nothing in the tool surface is removed; every addition is
opt-in except the automatic fluid point, which has an off switch.

## What changed

| Area | Before | Now |
|---|---|---|
| `nCellsBetweenLevels` (D-3) | hard-coded `4` in every scaffold | `scaffoldOptions.nCellsBetweenLevels`, integer 1..10, refused otherwise |
| `refinementRegions` (D-2) | block always empty | `{name, type: 'box'\|'sphere', min/max \| centre/radius, mode, level}` written as `searchableBox` / `searchableSphere`, validated against the domain |
| relaxed snap pass (D-4) | `maxNonOrtho 180` — never relaxed anything | `min(89, maxNonOrtho + 15)` by default (80 with the built-in 65), `relaxedMaxNonOrtho` overrides |
| fluid point (D-8) | only `scripts/fluid-point.py`, needs numpy, never called by a tool | `lib/fluidpoint.js`: deterministic lattice + nearest-triangle, no python; `mesh_build` with `scaffold: true` picks the point when `locationInMesh` is missing |
| advice ladders (D-9) | one rung for most categories | second measured rung for seven categories; new ops `layers.thickness`, `snap.smooth`, `layers.yplusRelax`, `domain.mode` |
| derived `minVol` (follow-up to D-6) | one tightening attempt at the reported suggestion | up to two attempts: `minVolume / 12`, then half of it; `minVolSource: "derived-then-measured"` |

## Measured evidence

The automatic fluid point, on a plain 10 mm cube with no `locationInMesh` (`.cache/live-d8`):

```
locationInMeshSource: auto (lattice+nearest-triangle)
fluidPoint: [59.6959, 39.374, 31.8683] mm, clearance 61.73 mm
gate: PASS   # 45 053 cells, maxNonOrtho 32.6617, maxSkewness 1.41671
```

That run also exposed the gate defect above: the derived threshold was `4.6e-11`
(`h_min` 2.226 mm / 2¹ = 1.11 mm), and exactly **one** face pyramid sat below it, so a healthy mesh
failed. A threshold sweep on the same case gives `4.6e-11` FAIL (1 illegal face), `2e-11` PASS,
`1e-11` PASS, `1e-14` PASS — the retry now lands at `2.3e-11` and reports
`minVolSource: "derived-then-measured"`. `mesh_check` on the same case still derives `1e-14` from its
own `meshQualityDict` and PASSes, which is why the case dictionary stays authoritative when present.

Unit tests: **93 tests, 91 pass, 0 fail, 2 skipped** (the two skips need `MESH_TUTORIALS_ROOT`).
New files: `mesh-build/test/refinement.test.mjs` (8), `mesh-build/test/fluidpoint.test.mjs` (6),
`mesh-build/test/ladders.test.mjs` (8).

## Verification

| Check | Result |
|---|---|
| `node scripts/check-catalogue.mjs` | 56 unique cards, one owner per id |
| `node scripts/check-versions.mjs` | mesh-build 1.2.0 · mesh-stl 1.2.0 · sim-core 1.2.0 (packages move together) |
| `node --test mesh-build/test/*.test.mjs` | 93 / 91 pass / 0 fail / 2 skipped |
| `node scripts/contract-test.mjs --no-mesh` | 30/30 (library + tool tiers; OpenFOAM and workbench tiers skip on a bare runner) |
| scaffold keys on a real case | `nCellsBetweenLevels 2`, a box region, `relaxed { maxNonOrtho 80 }` written into `snappyHexMeshDict` |

## Compatibility

- `minVol` behaviour changed on purpose: a derived threshold that flags healthy boundary cells is now
  re-checked at a measured value instead of failing the mesh. `minVolSource` and `minVolDerivation`
  say which rule produced the number; pass `minVol` to pin it.
- `locationInMesh` is no longer mandatory when `scaffold: true` and an STL is given. The answer says
  the point came from the geometry; `autoFluidPoint: false` restores the old failure.
- Everything else is additive: new scaffold keys, new advice rungs. Tool names, result fields and the
  `mesh-handoff/1` schema are unchanged.

## Install

```bash
dsh plugin --profile web add "git+https://github.com/AstDen/dsh-mesh-toolkit.git#v1.2.0"
```

or the market: add
`https://raw.githubusercontent.com/AstDen/dsh-mesh-toolkit/master/market/index.json` as an index source
and install *Mesh toolkit — pore-scale meshing for OpenFOAM*. Single-package tarball:
`mesh-toolkit-1.2.0.tgz` from the release assets.

## Known gaps

- `foamyHexMesh` tutorials on `flange`/`simpleShapes` die with SIGFPE inside OpenFOAM — not ours, and
  the manifest records them as manual.
- The `sim-core` modules imported relatively are still not evicted by a plugin toggle: a DSH restart
  is needed to see changes to hint ranking and the gate core in a live process.
- The workbench hyphen-patch defect stays pinned by the contract tier `M3c` (`known-gap`).
