# sim-core

Shared foundation for the Sim plugin family — **not installed on its own**. It is a
private library imported by relative path (`../sim-core/lib/<module>.js`) from
`mesh-stl` and `mesh-build`, so the files must stay siblings in this repository.

| Module | Responsibility |
|---|---|
| `config.js` | config layering: DEFAULTS → bundle config → external JSON → env; locates `sim-project.json` |
| `project.js` | profile schema defaults, built-in quality profiles, upward discovery |
| `paths.js` | resolves a relative case/STL path against cwd → `caseRoots` → project root, with `resolvedFrom` |
| `process.js` | `runBash` (sources OpenFOAM bashrc **before** `set -u`), `runPython`, Python detection |
| `env.js` | OpenFOAM bashrc/version detection, package version |
| `hints.js` | knowledge-card loader, scoring, shared `simHints` store |
| `checkmesh.js` | parses `checkMesh`, decides the verdict from **text** (rc is 0 on quality failures) |
| `gate.js` | writes a complete `meshQualityDict`, builds a case-local overlay, runs `checkMesh -meshQuality` |
| `passport.js` | `mesh-passport.json` / `case-manifest.json` and the cheap stat-first freshness check |

## Design rules

1. **Machine vs project.** The project profile holds units, case roots, quality
   profiles and artifact paths. Python paths, OpenFOAM roots and bashrc belong to the
   machine (external config / env) and never to a committed project file.
2. **Nothing silently guessed.** A missing profile means case-local mode with a
   warning; a missing `minVol` disables the absolute-volume check instead of failing a
   healthy mesh against an unrelated threshold.
3. **The verdict is text-based.** `checkMesh` exits 0 even when it prints
   `Failed N mesh checks`; `parseCheckMesh` + `verdictOf` are the only authority.
4. **No cross-plugin file reads.** Shared knowledge goes through the `simHints`
   service; capabilities (`simGeometry`, `simMesh`) are looked up with `ctx.get()` and
   degrade with an actionable message.

## Schemas

`schemas/` contains JSON Schema documents for `sim-project.json`,
`mesh-passport.json`, `case-manifest.json` and an STL passport row. They document the
contract; validation is advisory (tools accept partial profiles).

## Versioning

`0.3.0` is the first core. Plugins declare the capability versions they need
(`CAPABILITIES` in `lib/index.js`); the core stays backward compatible within `0.3.x`.
