# 1.0.0-rc.1 — first release candidate

**Tag:** `v1.0.0-rc.1` · **Packages:** mesh-build 1.0.0-rc.1 · mesh-stl 1.0.0-rc.1 · sim-core 1.0.0-rc.1

The three packages are versioned together from this release on. `1.0.0-rc.1` is a *candidate*: the API is
frozen, the docs are complete, and what remains before 1.0.0 is acceptance on a second machine and the
workbench-side half of the seam (Part B of `PLAN-workbench-integration.md`).

## Install

```bash
git clone git@github.com:AstDen/dsh-mesh-toolkit.git && cd dsh-mesh-toolkit && git checkout v1.0.0-rc.1
```

or unpack the three tarballs **side by side** into `~/.dsh/profiles/<profile>/node_modules/`
(`mesh-build`, `mesh-stl`, `sim-core`), then install both bundles. First run:
[`QUICKSTART.md`](QUICKSTART.md); error strings: [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## What is in the rc

Everything up to v0.7.5, unchanged in behaviour, plus the release packaging:

- [`QUICKSTART.md`](QUICKSTART.md) — install, enable, and the five calls from an STL to a delivered case, run
  end to end on 2026-11-26: `primitive` 10 mm cube → 45 053 cells, gate PASS (`maxNonOrtho 20.03°`,
  `maxSkewness 0.608`, `minVolume 9.81e-10 m³`), delivery DELIVERED with a `fluent3DMeshToFoam` round-trip at
  45 053 cells and 4.4001e-4 m³.
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — 29 rows of literal strings (tool messages, OpenFOAM fatals,
  gate advisories, sandbox traps) with cause and fix, each marked ✅ observed or 🟡 deduced.
- `scripts/contract-test.mjs` gained the **workbench tier** (T7 + M3/M3b/M3c): it delivers a case, mounts the
  installed `@yakovlev-i-a/dsh-openfoam-workbench`, runs *their* `openfoam_case_scaffold` on the delivery and
  compares the boundary conditions with `handoff.patches[]`. A gap in their code is reported as `known-gap`
  instead of failing our suite; `CONTRACT_TEST_REQUIRE_WORKBENCH=1` makes it hard. M3c builds a case whose patch
  name has a hyphen (`a1-cube`) and pins the defect below without needing a solver.
- The OpenFOAM tier writes its own 10 mm box fixture when the project's benchmark tree is not at hand, so the
  suite is self-sufficient in a fresh clone (`CONTRACT_TEST_STL` still overrides it).
- `scripts/check-versions.mjs` accepts semver prereleases (`1.0.0-rc.1`), so a release candidate can be tagged
  without weakening the package.json = CHANGELOG = banner check.

## Verification

| check | result |
|---|---|
| `node scripts/contract-test.mjs` (library + tools + OpenFOAM + workbench tiers) | **37/37** |
| `node scripts/contract-test.mjs --no-mesh` (CI mode) | **28/28** |
| `mesh_stl/scripts/smoke.mjs`, `mesh_build/scripts/smoke.mjs` | SMOKE OK |
| `scripts/check-versions.mjs`, `scripts/check-catalogue.mjs` | versions OK, 40 unique cards |
| QA parity JS ↔ python reference | 15/15 |
| benchmark baselines (`benchmark/TESTS.md` group A) | com2512/com2606 2 584 cells 9.7073°; org14 2 584 / 25.2146° |

## Known gaps

- The workbench's `parseBoundaryPatches` (`lib/of-engine.js:972`, `/(\w+)\s*\{([^}]*)\}/g`) truncates patch
  names at a hyphen: `a1-cube` becomes `cube`, and the scaffolded `0/U` then fails with
  `Cannot find patchField entry for a1-cube`. Until they fix it, avoid hyphens in STL/surface names.
- `sim-core` modules are not evicted by a plugin toggle: a change there needs a DSH restart. A version-only
  change never reloads any package — see TROUBLESHOOTING, "Reload and cache traps".
- CHT on OpenFOAM.org 14 is still unverified (`locationsInMesh` is com-only); route D (gmsh) is the documented
  alternative.
- Part B of the workbench seam (provider discovery, `openfoam_mesh_request` / `openfoam_mesh_feedback`,
  handoff-driven scaffolding) is not written; the file contract `handoff.json` is stable and tested.

## Next

1.0.0 = this rc + acceptance on a second machine (fresh profile, no project checkout) + the Part B merge if the
workbench author ships it.
