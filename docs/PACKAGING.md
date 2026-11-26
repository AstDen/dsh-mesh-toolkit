# Packaging and publication (blocker 2)

This document describes how the packages are built, tested and delivered to the user.
It belongs to the plan `PLAN-release-1.0.md`, blocker 2 "packaging".

## Publication channel: git installation (the decision)

The packages are **not published to npm** at this stage, and here is why — verified against the code, not by feel:

- `mesh-stl` and `mesh-build` import the shared core by a relative path: `../sim-core/lib/index.js`
  (`mesh-stl/index.js`, `mesh-build/index.js`). This works when the three directories sit side by side:
  in the profile (`link:`), when cloning the repository and in `node_modules` on a flat install.
  Inside a scoped package (`@astden/mesh-stl`) that path does not resolve, and publishing under the
  unscoped names `mesh-stl` / `mesh-build` / `sim-core` on npm is already taken by unrelated packages.
- All three packages are declared `private: true`, as is `@yakovlev-i-a/dsh-openfoam-workbench`
  (it is also installed from GitHub, not from npm). We repeat the proven workbench channel,
  so that the user has a single installation method for the whole set.
- `npm pack` nevertheless works and produces correct tarballs — they are attached to every
  Release and serve as the second, offline channel (`dsh plugin install_bundle <absolute path>`).

Bottom line: **the primary channel is git + `dsh plugin install_bundle` with an absolute path; the second is
`*.tgz` from the Release assets.** The move to npm (scoped names + switching imports to `sim-core/lib/...`
+ declaring `dependencies`) is described in the PLAN as a separate task and is not part of 1.0.

## Installation (user)

```bash
git clone https://github.com/AstDen/dsh-mesh-toolkit.git
cd dsh-mesh-toolkit
# the three packages are installed separately, order does not matter
dsh plugin install_bundle "$(pwd)/sim-core"
dsh plugin install_bundle "$(pwd)/mesh-stl"
dsh plugin install_bundle "$(pwd)/mesh-build"
```

After code changes: `plugin_manager set_plugin {target:"include:mesh-stl", enabled:false}` →
`enabled:true` (modules are re-read without restarting DSH — see the package READMEs).

From a tarball:

```bash
tar xzf mesh-build-0.5.4.tgz && dsh plugin install_bundle "$(pwd)/package"
```

## What CI checks (`.github/workflows/ci.yml`)

On every push to `master` and on every pull request, in a node matrix of **20 and 24**:

| Step | What it catches |
|---|---|
| `node --check` over `find` (not `git ls-files`) | syntax of every `.js`/`.mjs` |
| `python3 -m compileall` | syntax of `mesh-stl/generators/**` and `benchmark/scripts/**` |
| `bash -n` | syntax of `mesh-build/scripts/**/*.sh` (including the packaged delivery) |
| `scripts/check-catalogue.mjs` | cards: id, title, statement, topics, evidence, allowed status values, duplicates inside a package |
| `scripts/check-versions.mjs` | versions package.json == CHANGELOG == README banner, `engines`, licence, `repository`, presence of `cordis.patch.yml` |
| `smoke.mjs` of both packages | config, cards, catalogue, dry run without DSH |
| `qa-parity.mjs` (trimesh from pip) | the JS QA engine against the python reference; the reference comes from `tools/qa/stl_qa.py`, and in the standalone package from `mesh-stl/generators/cad/py_qa.py` |
| tarball check | that `generators/`, `lib/qa/`, `scripts/deliver/`, `docs/` made it into `npm pack` |

## What the Release workflow checks (`.github/workflows/release.yml`)

On a push of a `v*` tag (or manually with an explicit tag):

1. repeats the catalogue and version checks + both smokes;
2. builds `npm pack` for all three packages into `dist/`;
3. takes the description from `docs/RELEASE-<tag>.md`, otherwise assembles a brief one from the CHANGELOGs;
4. creates a Release (or updates an existing one) and attaches the three `.tgz` files;
5. prints the asset list.

So after `git tag v0.5.4 && git push origin v0.5.4` the Release appears by itself — the manual
API call from past releases is no longer needed.

## Versions and CHANGELOG

```bash
node scripts/bump.mjs patch          # all three packages: 0.5.4 / 0.3.6 / 0.4.4
node scripts/bump.mjs minor --packages mesh-stl
node scripts/bump.mjs 1.0.0 --dry-run
```

The script edits `package.json`, inserts a `## X.Y.Z — date` heading into the CHANGELOG (with a TODO
line that must be replaced by content), updates the banner in the root README and runs
`scripts/check-versions.mjs`. On a dirty tree it refuses to work without `--force`.

## Packaging defects found and fixed

- `mesh-stl/package.json#files` did not contain `generators/` — the tarball shipped **without** the
  python generators, and the `fcc-cell`, `channel-spheres`, `packing`, `cad-porous`, `blob-foam`
  families would have failed on `@package/generators/...`. `generators` is in the list now, and CI
  checks that the file is present in the tarball.
- `mesh-build/package.json#files` did not contain `docs/` — the README linked to `docs/PORTABLE.md`,
  which was not in the package. Fixed, and CI checks it.
- `engines.dsh` was `>=0.2.1-rc.5 <0.3.0` with DSH 0.2.2-rc.5 installed and workbench at
  `>=0.2.2-rc.1` — aligned to `>=0.2.2-rc.1 <0.3.0` in all three packages (the field was added
  in `sim-core`), and the `@deepseek-ai/dsh-*` peer ranges aligned the same way.
- `repository` was not filled in any package — added `git+https://…` with the package's `directory`.

## Limitations

- The npm channel is not open (see above) — if needed, that is a separate task of the plan.
- CI does not run meshing: `mesh_build` requires OpenFOAM, so only the assembly of configs/dictionaries
  (smoke + scaffold tests in `verify-*.mjs`) and QA parity are checked.
- The Python dependencies (`cadquery`, `scipy`, `skimage`) are not installed in CI: syntax and parity
  on `trimesh`+`numpy` are checked; families that need CAD are tested locally.
