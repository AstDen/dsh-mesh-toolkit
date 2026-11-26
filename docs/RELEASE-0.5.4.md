# 0.5.4 — packaging, CI and a release with no manual steps

Three packages: **mesh-build 0.5.4** · **mesh-stl 0.3.6** · **sim-core 0.4.4**.
This is the release for blocker 2 of the plan `PLAN-release-1.0.md`: the code did not change
the physics, but packaging is now checked automatically and the release is built from a tag.

## What is new, per package

### mesh-stl 0.3.6
- `files` includes `generators/` — previously `npm pack` dropped the python generators, and the
  `fcc-cell`, `channel-spheres`, `packing`, `cad-porous`, `blob-foam` families would have failed
  in the installed package on `@package/generators/...`.
- `scripts/qa-parity.mjs` finds the python reference itself (`tools/qa/stl_qa.py` → the packaged
  copy `generators/cad/py_qa.py` → `MESH_STL_QA_SCRIPT`) and requires a graph engine (see below),
  so parity is checked both in the standalone package and in CI.
- `scripts/smoke.mjs` passes without `sim-project.json`: in portable mode it checks the defaults
  (`project: "defaults"`, `registry: stl/registry.csv`, QA engine `js`), and the dry run is anchored to cwd.

### mesh-build 0.5.4
- `files` includes `docs/`: `docs/PORTABLE.md`, which the README links to, is now in the package.
- `scripts/smoke.mjs` passes without a profile (`project: "defaults"`, `caseRoot: "cases"`,
  gate profile `project`).

### sim-core 0.4.4
- The default quality profile in the mode without `sim-project.json` is `project` (60° / skew 2 /
  boundary 4), as `docs/PORTABLE.md` and the `portable-mesh-build` card promise. Previously it
  silently took `gate` (65°) — a discrepancy between code and documentation. An explicit
  `gate.profile` in the profile still wins.
- Added `engines.dsh`.

### Common
- `engines.dsh: ">=0.2.2-rc.1 <0.3.0"` in all three packages (it was `>=0.2.1-rc.5 <0.3.0`),
  and the `@deepseek-ai/dsh-*` peer ranges are aligned the same way. The upper bound is kept on
  purpose: a DSH major may change the API.
- Filled in `repository` with each package's `directory`.
- The mesh-stl python families now explicitly require `networkx`: without a graph engine trimesh
  fails with `ImportError: no graph engines available!` (only caught in a clean CI environment).

## Automation

- **CI** (`.github/workflows/ci.yml`, node 20 and 24): JS/Python/shell syntax, the card catalogue
  (35 unique, 10 shared — a report, not an error), version consistency (package.json == CHANGELOG ==
  README banner), both smokes, JS-QA parity against the python reference, tarball completeness.
- **Release** (`.github/workflows/release.yml`): on a `v*` tag it runs the checks, packs three
  `.tgz` files and creates/updates a Release with the description from `docs/RELEASE-<tag>.md`.
- **`scripts/bump.mjs`**: one command for three versions + CHANGELOG headings + README banner +
  `check-versions`.
- The publication-channel decision and install commands are in `docs/PACKAGING.md` (git + `install_bundle`,
  tarballs as the offline option; npm is deferred: the relative import `../sim-core/lib/...` and the
  unscoped names are taken).

## Installation

```bash
git clone https://github.com/AstDen/dsh-mesh-toolkit.git
cd dsh-mesh-toolkit
dsh plugin install_bundle "$(pwd)/sim-core"
dsh plugin install_bundle "$(pwd)/mesh-stl"
dsh plugin install_bundle "$(pwd)/mesh-build"
```

Or from this release's assets: unpack the `.tgz` and run `dsh plugin install_bundle "$(pwd)/package"`.

To reload after code changes without restarting DSH: `plugin_manager set_plugin
{target:"include:mesh-stl", enabled:false}` → `enabled:true` (modules are re-read if the files
have changed).

## Verified

- CI is green on node 20 and 24 (every step, including parity 9/9 and tarball completeness).
- The release was built by the workflow: tag `v0.5.4`, three assets `mesh-build-0.5.4.tgz`,
  `mesh-stl-0.3.6.tgz`, `sim-core-0.4.4.tgz`.
- `node scripts/check-catalogue.mjs` → 35 cards; `node scripts/check-versions.mjs` → versions OK.
