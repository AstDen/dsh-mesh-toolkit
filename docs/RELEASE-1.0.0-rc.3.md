# 1.0.0-rc.3

Third release candidate. It exists because of the clean-user acceptance: install the published package where
no project, no checkout and no project venv exist, then run the two first-run commands literally.

## Verified on a clean user

Full record: [`docs/ACCEPTANCE.md`](docs/ACCEPTANCE.md).

| Step | Outcome |
|---|---|
| `pnpm add "git+https://github.com/AstDen/dsh-mesh-toolkit.git#<commit>"` | `+ mesh-toolkit 1.0.0-rc.2` (then `-rc.3`), 21 packages |
| `node …/scripts/doctor.mjs` | **READY — 7 pass, 2 warn, 0 fail** (warnings: portable mode, no trimesh in system python) |
| `node …/scripts/demo.mjs` | **DEMO OK in 26.3 s** — 2 220-triangle STL, 148 288-cell mesh, gate PASS, delivery written |

Two defects the acceptance found, both fixed here:

- portable mode refused every absolute `outDir` when `sim-project.json` was absent (the guard compared
  against an empty `config.projectRoot`);
- `scripts/demo.mjs` crashed inside its own diagnostic when the generator failed before `missingOutputs`
  existed, hiding the real cause.

## What else is in this release

- **34 unit checks** for the four mathematical modules (`domain.js`, `caps.js`, advice/`revise.js`,
  `surfacecheck.js`), on Node's built-in runner, no dependencies; CI runs them (`npm test`).
- **Internal-domain sanity fix**: a closed body meshed with `domain.type: "internal"` is no longer rejected
  for lacking the `world` patch (snappy legitimately consumes it); the rule now requires a surviving surface
  patch. Measured: closed 10 mm box with a 3.5 mm cavity → 50 256 cells, gate PASS, one patch `cav`.
- **Millimetre hint**: the `locationInMesh` refusal now says when the point looks like millimetres.
- **`CONTRIBUTING.md`**, issue templates (defect, feature), PR template, **`docs/VERSION-POLICY.md`** (what a
  version promises, how a DSH major is handled).
- **`docs/GALLERY.md`**, an honest **comparison table** in the README against
  `dsh-openfoam-workbench` 0.9.22, and `docs/ANNOUNCEMENT.md` with ready-to-post text.
- `scripts/bump.mjs` accepts an explicit prerelease, is idempotent, and keeps the root manifest version in
  step with the three trees (`check-versions.mjs` enforces it).

## Known gaps

- Fluent has never opened a delivered `.msh` (built and round-tripped through OpenFOAM only).
- OpenFOAM.org 14 multi-region CHT is unverified (`locationsInMesh` is OpenCFD-only).
- The workbench's hyphenated-patch parser defect is pinned by contract check `M3c`, not fixed upstream
  (issue #1).
- Announcements are drafted but **not posted**: that needs the maintainer's accounts.
