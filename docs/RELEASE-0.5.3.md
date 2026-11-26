# 0.5.3 — works in an empty directory

Packages: **mesh-build 0.5.3 · mesh-stl 0.3.5 · sim-core 0.4.3** (2026-11-26).
Closes blocker 1 of the plan [`PLAN-release-1.0.md`](PLAN-release-1.0.md): the toolkit no longer
requires the research project.

## Highlights

- **`sim-project.json` is not mandatory.** The config returns `project` = the profile name or
  `"defaults"`, and instead of refusing, the tools write `project: "defaults"`, `configured: false`
  and a hint in `next`. Defaults: cases `./cases`, STL registry `./stl/registry.csv`
  (created automatically), generator outputs `./stl/generated/<family>/`, gate profile `project`.
- **Delivery ships with the package.** `mesh_deliver` no longer depends on `tools/deliver/`:
  the bundle carries `scripts/deliver/make_delivery.sh`, `scripts/qa/mesh_gate.sh`,
  `scripts/deliver/region_layout.py`. The delivery gate writes its overlay into `<outDir>/.gate`
  via `MESH_GATE_CACHE_DIR`, and `scriptOrigin` shows whose script ran.
- **The end-to-end scenario is verified in `/tmp`:** `stl_generate(primitive)` (12 triangles, PASS, JS-QA) →
  `stl_check` PASS → `mesh_build` snappy (2584 cells: blockMesh → surfaceFeatureExtract →
  snappyHexMesh) → `mesh_check` gate **PASS** (18.29° / 0.2997) → `mesh_deliver` **DELIVERED**
  (1.8 MB of artefacts). The same run went through the real tool handlers.
- **Knowledge cards:** `portable-setup` (mesh-stl) and `portable-mesh-build` (mesh-build) —
  what is available without a profile and how to override it. The merged catalogue holds 35 cards in total.
- **Document:** [`docs/PORTABLE.md`](PORTABLE.md) — the defaults table, the scenario,
  and what still requires a profile (OpenFOAM installations, custom gate thresholds, units ≠ mm).

## Regressions

- `plugins/mesh-stl/scripts/smoke.mjs`, `plugins/mesh-build/scripts/smoke.mjs` → SMOKE OK.
- `plugins/mesh-stl/scripts/qa-parity.mjs --project` → 15/15 matches against the python reference.
- A live run after reloading the plugins: `stl_hints({id:"portable-setup"})` finds the card,
  `mesh_check` on `benchmark/runs/20261125-1805/mesh/a1` — PASS 18.2905°.

## Update

```bash
cd <profile> && dsh plugin update mesh-build mesh-stl sim-core   # or however you install the packages
# then restart DSH: the live process's ESM graph holds the old module versions
```

## What comes next

Blocker 2 (CI, publication channel, `engines.dsh`) and blocker 3 (the contract with
`dsh-openfoam-workbench`) — see the plan; after those comes `1.0.0-rc.1`.
