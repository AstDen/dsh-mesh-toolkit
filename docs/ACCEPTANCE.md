# Acceptance on a clean user

The only acceptance that counts: install the published package where no `sim-project.json`, no project
virtualenv and no repository checkout exist, then follow [`QUICKSTART.md`](QUICKSTART.md) literally.

This page records the run of **2026-11-26** and the defects it produced. It is a log, not a claim: every number
below was printed by the commands shown.

## Procedure

```bash
export HOME=$ACC/home TMPDIR=$ACC/tmp TMP=$ACC/tmp TEMP=$ACC/tmp \
       XDG_RUNTIME_DIR=$ACC/tmp XDG_STATE_HOME=$ACC/tmp XDG_CACHE_HOME=$ACC/tmp
mkdir -p $ACC/work && cd $ACC/work

# 1. install from the public repository, pinned to a commit (no clone, no tarballs)
pnpm add --store-dir $ACC/home/store "git+https://github.com/AstDen/dsh-mesh-toolkit.git#<commit>"

# 2. a real DSH host provides the peers; here they are symlinked from an installed DSH
for p in cordis dsh-tools dsh-skill dsh-agent dsh-llm; do
  ln -sfn "$DSH_NODE_MODULES/@deepseek-ai/$p" node_modules/@deepseek-ai/$p
done

# 3. the two first-run commands
node node_modules/mesh-toolkit/scripts/doctor.mjs
node node_modules/mesh-toolkit/scripts/demo.mjs
```

The run used `HOME`/`TMPDIR`/`XDG_*` inside a scratch directory because pnpm needs a writable store, and a
plain `/tmp` is wiped between steps in a sandboxed agent shell. The working directory sits outside the
repository, so `sim-project.json` is absent — that is what makes this an acceptance rather than a smoke test.

## Result (commit `35e9aba`)

| Step | Outcome |
|---|---|
| `pnpm add` | `+ mesh-toolkit 1.0.0-rc.2`, 21 packages, 7.2 s |
| `doctor.mjs` | **READY — 7 pass, 2 warn, 0 fail** |
| `demo.mjs` | **DEMO OK in 26.3 s** — geometry → STL contract → mesh → gate → delivery |

`doctor` warnings, both expected on this machine:

- `WARN project` — no `sim-project.json` upward from the cwd, so the tools run in **portable mode**
  (`project: defaults`, `caseRoots: ["./cases"]`, `workRoot` under the cwd). This is the supported
  standalone configuration, not a failure.
- `WARN python` — the system `python3` has `numpy`/`scipy` but no `trimesh`/`cadquery`. The `primitive`
  family and the in-process JS QA need no Python at all; the warning only limits the python generator
  families and the python QA reference.

`doctor` also found the OpenFOAM bashrc, all five executables (`blockMesh`, `snappyHexMesh`, `checkMesh`,
`cartesianMesh`, `gmshToFoam`) and `pvpython` 6.2.1 on this machine — the same ones the project used.

`demo` output (portable mode, default output directory `./.mesh-demo`):

| Step | Measured |
|---|---|
| 1/5 geometry | `pore-demo.stl` — box 10 mm with a 3.5 mm-radius sphere removed, 2 220 triangles, 2 closed shells |
| 2/5 STL contract | `PASS`, watertight, winding consistent |
| 3/5 mesh | snappy, background `59 × 46 × 46`, **148 288 cells** |
| 4/5 gate | project gate **PASS** (`checkMesh -meshQuality`), passport fresh, handoff written |
| 5/5 delivery | `deliver/openfoam_demo/` (case + `.foam` marker + `.tar.gz`), `ansys_demo/`, `delivery_demo.{json,md}` |

## Defects found by this run (fixed in the same session)

1. **`scripts/demo.mjs` crashed in its own diagnostic** when `stl_generate` failed before `missingOutputs`
   existed: `TypeError: Cannot read properties of undefined (reading 'slice')`. The real cause (a refused
   `outDir`) was hidden behind the crash. Fixed by falling back through `failure → error → missingOutputs →
   the whole result`, and by printing up to 600 characters.
2. **Portable mode refused every absolute `outDir`**: `outDir must stay inside the project root : /tmp/…`
   — the guard compared against `config.projectRoot`, which is empty when there is no `sim-project.json`.
   Fixed in `mesh-stl/lib/generators.js`: the project root falls back to `config.rootDir`/`cwd`, and the
   refusal now says that portable mode treats the working directory as the root.
The refusal above is also what an explicit `--out <sibling directory>` hits on purpose: portable mode treats
the working directory as the root, so both `QUICKSTART.md` and `demo.mjs` keep the default `./.mesh-demo`
inside it.

Both fixes are covered by the run above: `doctor` and `demo` now complete from a clean directory with no
project, no checkout and no environment variables other than the ones a shell already has.

## What this run does not cover

- A real DSH host enabling the bundle through `install_bundle` (the peers were symlinked instead) — the
  plugin-market route is documented in `docs/QUICKSTART.md` and was exercised separately with
  `dsh plugin --profile test add`.
- Windows/macOS, and any machine without OpenFOAM (the demo needs a mesher).
- Fluent opening the delivered `.msh` (still unverified, see `docs/TROUBLESHOOTING.md`).
