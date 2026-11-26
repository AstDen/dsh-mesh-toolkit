# Contributing

Thanks for looking. This repository is a DSH plugin bundle for pore-scale meshing; it is
developed and verified against a real OpenFOAM installation, so a useful contribution
usually comes with a measurement.

## Before you start

1. Read [`README.md`](README.md) (what the tools do) and [`docs/PACKAGING.md`](docs/PACKAGING.md)
   (how the repository is laid out and released).
2. Run the local checks — they are the same ones CI runs:

   ```bash
   node scripts/check-catalogue.mjs   # knowledge cards parse, ids unique
   node scripts/check-versions.mjs    # package.json = CHANGELOG = README banner
   npm test                           # unit tests, no OpenFOAM needed
   node scripts/contract-test.mjs --no-mesh   # contract tiers that do not mesh
   ```

   With OpenFOAM and ParaView available, also run `node scripts/doctor.mjs`,
   `node scripts/demo.mjs` and the full `node scripts/contract-test.mjs`.

## What an issue needs

Use the templates in `.github/ISSUE_TEMPLATE/`. For a defect, include:

- `node scripts/doctor.mjs --json` output (redact paths if you need to);
- the **exact** tool call (name + JSON arguments) and the exact result text — the tools
  answer with structured `error`/`next` fields, and those strings are what the docs and
  the troubleshooting table are keyed on;
- the log tail if a helper failed (`<case>/logs/*.log`).

For a new generator family or a meshing route, say what geometry and what scale, and attach
an STL (or the parameters that reproduce it) plus the gate verdict.

## Ground rules for changes

- **Numbers come from a run.** A claim about quality, timing or support goes in with the
  command that produced it. `docs/TROUBLESHOOTING.md` shows the level of evidence expected.
- **`minVol` is absolute** (m³) — the volume of a face–cell-centre pyramid, not a fraction of
  the cell. Use `minVol ≈ h_min³ / 6` and pass it explicitly.
- **The gate verdict is read from the log text.** `checkMesh` exits 0 even when it prints
  `Failed N mesh checks`; never turn an exit code into a verdict.
- **STL in millimetres, cases in metres.** `snappyHexMeshDict geometry.scale 0.001`,
  `locationInMesh` in metres.
- **Keep the published repository English-only** (names, docs, strings); `locale/ru.json` is the
  one exception.
- **No hand-edited meshes.** Dictionaries and `polyMesh` are produced by the tools; a fix in a
  fixture belongs in the tool.

## Knowledge cards

Cards live in `mesh-stl/data/hints/*.json` and `mesh-build/data/hints/*.json`. Each card is
`{id, title, topics, appliesTo, when, recipe, evidence, status}`; `evidence` must be a
**non-empty array** of strings (`check-catalogue.mjs` enforces it). Write a card only for a
verified rule, and say what it was verified on.

## Commits and pull requests

- One logical change per commit; the message states the *why*.
- Bump the package version and its `CHANGELOG.md` together (see `docs/VERSION-POLICY.md`), then
  re-pin the market index: `node scripts/make-index.mjs`.
- Pull requests are expected to keep CI green. If a tier is skipped in your environment, say
  which one and why in the description.

## Licence

By contributing you agree that your contribution is licensed under the MIT licence of this
repository (see [`LICENSE`](LICENSE)).
