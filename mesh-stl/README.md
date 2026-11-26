# mesh-stl — DSH plugin for STL generation

A set of three tools for the `Mesh_3D_pore_scale` project: parametric geometry generation, STL contract
checking and a passport row in `stl/registry.csv`. It runs on the project's real scripts
(`geometry/`) and invents nothing: every metric is computed by its own JS QA (`lib/qa/`), while
`tools/qa/stl_qa.py` remains the parity reference and is available as `engine: "python"`.

## Tools

| Tool | What it does | Arguments |
|---|---|---|
| `stl_hints` | knowledge cards: the STL contract, cleanup, tessellation, gaps, snappy traps | `query`, `id`, `limit` |
| `stl_generate` | run a generator from the family registry | `family`, `preset`, `name`, `outDir`, `params`, `dryRun` |
| `stl_check` | STL QA + cleanup + passport row | `stl`, `cleanup`, `cleanOut`, `expectVolume`, `expectArea`, `expectBodies`, `maxVolumeErr`, `maxAreaErr`, `register`, `family`, `generator`, `paramsFile`, `fluidOrSolid`, `notes` |


## Description and topics

**Description** (the bundle passport, `package.json` → `description`): STL generation from verified families
(FCC cell, channel with sphere packing, double-layer burner, packings, CadQuery CAD), contract QA
(watertight, winding, mm), cleanup and a passport in `stl/registry.csv`.

**Topics** (`package.json` → `keywords`, for search/marketplace): `stl`, `geometry`, `pore-scale`,
`cadquery`, `trimesh`, `watertight`, `mesh-preparation`, `qa`, `passport`, `generator-presets`.

**For the chat** (what the model actually sees): the tool `description`s in `index.js`, `description` +
`whenToUse` in `lib/skill.js`, the `plugin-mesh-stl` card in `data/hints/plugin.json` (this card's `topics`
match `keywords`). Routing goes by these texts — when you change the tool set, update them.

With no arguments `stl_generate` lists families and presets, `stl_hints` lists the card catalog.

## Installation

The only supported path is the DSH `plugin_manager` tool (it needs user confirmation):

```json
{ "action": "install_bundle", "target": "<absolute path to the repository>/plugins/mesh-stl" }
```

Substitute your own path — DSH accepts only an absolute one (`$(pwd)/plugins/mesh-stl` from the project root).

It adds a `link:` to the plugin directory in the profile and enables the entry in `dsh.profile.bundles`.
The live session re-reads changed code without a DSH restart: on reload the plugin graph is rebuilt,
and ESM modules are unloaded for those files that changed since the previous read (comparison against disk in
`@deepseek-ai/dsh-hmr`). So after an edit: `plugin_manager` → `set_plugin {target:"include:mesh-stl",
enabled:false}`, then `enabled:true`. A bare disable→enable with unchanged files keeps the old
modules in memory — that is not a configuration error.
A check:

```bash
node plugins/mesh-stl/scripts/smoke.mjs        # without DSH: config, cards, catalog, dry-run
node plugins/mesh-stl/scripts/smoke.mjs --full # + a real FCC generation into .cache/mesh-smoke
```

After installation `mesh-stl` appears in the skill catalog, and `stl_hints`, `stl_generate`, `stl_check`
among the tools. If the plugin activates with a schema error, DSH points to the exact parameter path — fix
`index.js`, then repeat `set_plugin` with `"target": "include:mesh-stl"`.

Requirements: Node ≥ 20, DSH `>= 0.2.2-rc.1 < 0.3.0`. The built-in families (`primitive`,
`stratified-channel`, `box-array`) and STL QA work without python and without project data. The python families
(`fcc-cell`, `channel-spheres`, `double-layer-burner`, `blob-foam`, `packing`, `cad-porous`) run
scripts from this package's `generators/` and require `trimesh`, `numpy` and `networkx` (trimesh without a graph
engine fails with `ImportError: no graph engines available!`; for some families — `cadquery`,
`scipy`, `skimage`). Before a run the plugin checks the imports and returns `python-bridge-missing`
with the install command instead of a traceback.

## Configuration

Precedence: the plugin entry's `config` → external JSON → environment variables.

```json
// ~/.config/mesh-stl/config.json   (or $MESH_STL_CONFIG=/path/config.json)
{
  "projectRoot": "/path/to/Mesh_3D_pore_scale",
  "python": "/path/to/Mesh_3D_pore_scale/.venv/bin/python",
  "workRoot": "stl/generated",
  "registry": "stl/registry.csv",
  "timeoutMs": 1800000
}
```

`projectRoot` and `python` can be omitted: the root is searched upwards from the agent's working directory for
`sim-project.json`, and the interpreter defaults to `<projectRoot>/.venv/bin/python`.
`workRoot`/`registry` are paths **relative** to the project root, and without a profile — **relative to the current
directory**; `registry` may be absolute. The passport table is created on demand (it writes the header
itself). If the file cannot be written (read-only directory, a foreign header), QA is still computed: the result
carries `registered: {ok: false, error, row}` and a warning line in `next`, and the verdict is not broken.

Variables: `MESH_STL_PROJECT_ROOT`, `MESH_STL_PYTHON`, `MESH_STL_WORK_ROOT`, `MESH_STL_REGISTRY`,
`MESH_STL_TIMEOUT_MS`, `MESH_STL_CONFIG`, plus `MESH_STL_OPENFOAM_BASHRC` (an explicit `etc/bashrc`) and
`MESH_STL_OPENFOAM_ROOTS` (extra installation directories, colon-separated, in addition to the standard
`/usr/lib/openfoam`, `/opt/openfoam`, `~/openfoam`).

If the project is not found, the tools do not fail; they return `configured: false` and say what to provide.

## Shared core and built-in generators

The mechanics (config, the `sim-project.json` profile, path resolver, process runner, cards, QA) live in
`../sim-core` (package `sim-core`, 0.4.x); `lib/common.js` is a thin facade. The plugin registers the
`simGeometry` service (`hints`/`generate`/`qa`) and contributes its cards to the shared `simHints`.

Three families write STL in plain JS and work **without a project** and without python: `primitive`
(`lib/primitives.js`; `shape` = `box` | `sphere` | `cylinder`, parameters `size_mm` /
`radius_mm`+`height_mm` / `center_mm` / `segments`/`rings`/`sections`), `stratified-channel`
(`lib/generators/stratified.js`; two boxes of 12 triangles each) and `box-array`
(`lib/generators/box-array.js`; a lattice of spheres/cylinders plus a container). The shared triangle emitters are
`lib/shapes.js`. QA of every output is the built-in JS (`lib/qa/`).

`generators.root` (`sim-project.json` → `generators.root`, or `MESH_STL_GENERATORS_ROOT`) selects the
script tree: `package` (by default `generators/` inside this package) or `project`
(the research `geometry/` through `projectScript`/`projectPreset`). Presets live in `generators/presets/<family>/`.
Extra script trees are set in `sim-project.json.geometry.scriptRoots` (absolute paths):
the resolver returns `resolvedFrom`; a project-relative path is looked up in the project first.

## Generator families (`data/generators.json`)

| id | script (`generators.root = package`) | presets |
|---|---|---|
| `fcc-cell` | `generators/pore_cell/gen_fcc_cell.py` | `generators/presets/pore_cell/fcc_cell_d5*.json` |
| `channel-spheres` | `generators/pore_cell/gen_channel_spheres.py` | `generators/presets/pore_cell/channel_spheres_*.json` |
| `double-layer-burner` | `generators/pore_cell/gen_double_layer_burner.py` | `generators/presets/pore_cell/double_layer_burner_*.json` |
| `blob-foam` | `generators/pore_cell/gen_blob_foam.py` | `generators/presets/pore_cell/blob_foam_*.json` |
| `packing` | `generators/packings/gen_packing_table.py` → `gen_packing_stl.py` | `generators/presets/packings/*.json` |
| `cad-porous` | `generators/cad/gen_cq_porous.py` (+ `py_qa.py`) | `generators/presets/cad/*.json` |
| `primitive` | JS `lib/primitives.js` | `data/primitives/*.json` |
| `stratified-channel` | JS `lib/generators/stratified.js` | `generators/presets/stratified/*.json` |
| `box-array` | JS `lib/generators/box-array.js` | `generators/presets/box-array/*.json` |

With `generators.root = "project"` the python families take `projectScript`/`projectPreset` from
the research tree (`geometry/pore_cell/...`), so the old mode is preserved.

Every run: copy/merge `params.json` → generator steps → a log per step in `<outDir>/logs/` →
QA of every declared output (JS by default) → return `{ok, files[{path, qa}], commands, next}`.

## Portable mode (without `sim-project.json`)

`stl_generate`/`stl_check` work in an empty directory: the report carries `project: "defaults"`,
relative paths are resolved from the current directory, the registry is `./stl/registry.csv` (created
automatically), outputs go to `./stl/generated/<family>/`. A read-only registry does not break the verdict
(`registered: {ok:false, error, row}`). The full end-to-end scenario, including meshing and delivery, is in
[`mesh-build/docs/PORTABLE.md`](../mesh-build/docs/PORTABLE.md); card `portable-setup`.

## Knowledge cards (`data/hints/*.json`)

`snappy.json` — meshing traps that affect geometry (minVol, units, patches on domain planes,
interface level, layers, `castellatedBufferLayer`, `symmetry`); `geometry.json` — the STL contract, cleanup,
CadQuery tessellation, the clearance rule, the unsuitability of gmsh tetrahedra, named patches, units.

Card format: `id`, `title`, `topics[]`, `status` (`verified|derived|unverified`), `when`, `statement`,
`recipe[]`, `evidence[]`, `improves[]`. Search is word-based with light stemming; an exact match weighs more.

## Extending (without touching code)

- **Add a family**: an object in `data/generators.json` — `script`, `presets.dir`, `preset.include`
  (a glob, so that other families' presets are not shown), `args` with the placeholders `{paramsFile} {outDir} {json}
  {rawOut} {cleanOut} {solidRawOut} {solidOut} {fluidRawOut} {fluidOut} {fluidPatchesOut} {ballsCsv}
  {contactsCsv} {packingJson}`, `outputs[{path, role, qa}]`, `steps[]` (several steps sharing the same context).
- **Remove a family/route**: delete the entry — the tool stops offering it.
- **Add knowledge**: a JSON card in `data/hints/`; `statement` is a checkable fact, `evidence` — experiment numbers
  and/or verbatim errors.
- After an edit: `node scripts/smoke.mjs` (works without DSH) and a bundle reload —
  `plugin_manager set_plugin {target:"include:mesh-stl", enabled:false}` → `enabled:true`.
  No DSH restart is needed: changed modules are unloaded from the ESM cache on reload.

## Limits

- It does not build meshes (that is `mesh-build`) and does not run solvers.
- It does not silently "fix" parameters: if a generator fails, `failure` is returned with the log tail and the path to the full log.
- Numbers in the cards come from the project journal (`journal/EXPERIMENTS.md`, `journal/DECISIONS.md`), not from memory.
