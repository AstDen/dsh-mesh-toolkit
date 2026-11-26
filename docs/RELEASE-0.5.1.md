# 0.5.1 — benchmark-driven fixes, threshold parity, version stamping

Package versions: **mesh-build 0.5.1 · mesh-stl 0.3.1 · sim-core 0.4.1** (plus the shared
regression suite `benchmark/`). The release closes 16 of the 18 defects found by the
global tooling audit (`benchmark/runs/20261125-1805`, 61 cases:
45 PASS / 15 FAIL / 1 GAP).

## What works differently now

**mesh-build**

- `lib/precheck.js` (new): STL outside the domain (mm × 0.001), background-mesh cell budget,
  domain-patch check after meshing, cfMesh refusal on mm geometry with the exact octree level.
  Geometry is no longer "silently clipped".
- `scaffold`: `refinementLevels` accepts a `[min, max]` pair (it was `(2 2)`, the reference
  required `[1, 2]`); an unknown surface key is an explicit error instead of a silent
  `defaultLevel`; `meshQualityDict` is written from the gate profile (`maxNonOrtho`,
  `minVolRatio`, `minTwist`) — no more hand-editing the dictionary, as in exp-022.
- `gate`: if a cfMesh case has no `system/fvSchemes`/`fvSolution`, minimal copies are
  synthesised into the overlay (they cannot affect the metrics); the response carries
  `synthesized` and an advisory.
- `mesh_check`: passport freshness is computed BEFORE the overwrite — a stale mesh no longer
  looks "fresh".
- `mesh_build`/`mesh_check` return `version {reported, onDisk, stale, warning}`;
  passports and case manifests are stamped with the `package.json` version as of the call.
- The mesh-build and mesh-stl card catalogues are merged into one store — 33 cards,
  and queries about org14/cfMesh/watertight find the right one (F3/F4/F5/F7).

**mesh-stl**

- The `stratified-channel` family (closes GAP D3): two closed STL regions
  along the interface plane, preset `channel_10x10x20_h8`.
- `stl_check`: counts non-manifold edges; a "raw" non-watertight STL now yields FAIL,
  not PASS with a warning.

**sim-core**

- Dictionary synthesis for the gate, CHANGELOG, version 0.4.1.

**benchmark**

- `TESTS.md`: 19 protocol fixes (E1 domain, level pairs, minVol by the `h_min³/6` rule,
  cfMesh units in metres, `bodies = clusters`, H1/H2/H9/G8) + section 18.
- `scripts/fluid_point.py`: an exact probe over the bucket index, `--max-seconds`,
  and a message with the best clearance achieved — it no longer hangs on dense packings.

## Verified

- `experiments/_scratch/verify-fixes.mjs` — 15/15; `verify-actualize.mjs` — 10/10
  (threshold parity of the dictionary, a real snappy run with 2584 cells, gate PASS).
- `scripts/smoke.mjs` of both plugins — SMOKE OK.
- Repeat benchmark runs: D1 with a correct point (ENV-2), V1–V4 reproduce
  the exp-019 references (2584 cells, 9.7073° / 25.2146°, gmsh 1135 tetrahedra).

## Important

- **Restart DSH** after the update: a live process keeps the old ESM graph,
  so `mesh_hints()` may still report `reported: "0.2.0"` — the `version` block
  in the tool responses says exactly what to do.
- `gate.minVol` is still an absolute volume: the rule is `h_min³/6`, the default value is off.
