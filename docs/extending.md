# Extending the toolkit

Rule of thumb: **data first, code second**. Everything that changes often is JSON;
code changes only when a tool's own behaviour changes.

## 1. Generator family (`mesh-stl/data/generators.json`)

```json
{
  "id": "my-family",
  "title": "My family",
  "script": "geometry/path/gen_my.py",
  "presets": "geometry/path/params",
  "preset": { "include": ["my_*.json"], "default": "my_default.json" },
  "args": ["--params-file", "{paramsFile}", "--out", "{rawOut}", "--json", "{json}"],
  "outputs": [
    { "file": "{cleanOut}", "role": "solid", "qa": true },
    { "file": "{rawOut}", "role": "raw", "qa": false }
  ]
}
```

`include` globs decide which presets a family shows; `default` is used when
`stl_generate` gets no `preset`. Every declared output is QA-checked unless
`"qa": false`.

Context placeholders available in `args` and `outputs`:

```
{paramsFile} {outDir} {name} {json} {rawOut} {cleanOut}
{solidRawOut} {solidOut} {fluidRawOut} {fluidOut} {fluidPatchesOut}
{ballsCsv} {contactsCsv} {packingJson}
```

Multi-step pipelines use `steps` (see `packing`: table → STL). Logs go to
`<outDir>/logs/step-N.log`; a non-zero exit stops the pipeline and returns the
failing step plus its log path.

## 2. Knowledge card (`data/hints/<topic>.json`)

A JSON array, or `{ "cards": [...] }`:

```json
{
  "id": "snappy-minvol",
  "title": "minVol — абсолютный объём",
  "topics": ["snappy", "minvol", "layers"],
  "status": "verified",
  "when": "слои не растут или illegal faces при здоровой сетке",
  "statement": "…one falsifiable paragraph…",
  "recipe": ["what to change, step by step"],
  "evidence": ["same mesh: minVol below h_min³/6 → illegal faces; h_min³/6 → 0"],
  "improves": ["layer coverage"],
  "appliesTo": ["mesh_build snappy"]
}
```

Rules: `id`, `title`, `statement` are required; `status` is `verified` or
`derived`; numbers in `evidence` must come from a real run and stay reproducible,
never estimated. `topics` and `appliesTo` are search metadata used by
`stl_hints` / `mesh_hints`.

## 3. Route and thresholds (`mesh-build/data/engine.json`)

```json
{
  "id": "my-route",
  "title": "…",
  "when": "…",
  "software": ["…"],
  "requires": ["system/myDict"],
  "steps": [
    { "name": "mesh", "command": "myMesher -case {caseDir}", "when": "always" }
  ],
  "failures": ["exact error string → what it means"]
}
```

Step conditions: `always`, `blockMesh` (when the case has `blockMeshDict`),
`features` (when `surfaceFeatureExtractDict` exists), `parallel` / `serial`
based on `np`, `splitRegions` when `splitRegions` is requested.

Command placeholders: `{caseDir}` (shell-quoted), `{np}`, `{python}`, `{msh}`,
`{gmshScript}`, `{gmshArgs}`.

Quality profiles live in the same file:

```json
"profiles": {
  "gate":    { "maxNonOrtho": 65, "maxBoundarySkewness": 20, "maxInternalSkewness": 4, "minFaceWeight": 0.05, "minVolRatio": 0.01, "minDeterminant": 0.001, "minLayerCoverage": 0 },
  "project": { "maxNonOrtho": 60, "maxBoundarySkewness": 4,  "maxInternalSkewness": 2, "minFaceWeight": 0.1,  "minVolRatio": 0.05, "minDeterminant": 0.001, "minLayerCoverage": 0.8 }
}
```

The gate calls `tools/qa/mesh_gate.sh`; the project source of truth for thresholds
is `journal/DECISIONS.md` and `AGENTS.md §6`.

## 4. Scaffold options (`mesh_build scaffoldOptions`)

| Option | Meaning |
|---|---|
| `domainMin`, `domainMax` | box in **metres** |
| `cells` or `cellSize` | background mesh resolution in metres |
| `locationInMesh` / `locationsInMesh` | `[x,y,z]` or `[{point,name}]`; more than one point implies `splitRegions` |
| `refinementLevels` | `{surfaceName: level}` for `refinementSurfaces` |
| `defaultLevel` | level for surfaces not listed |
| `layerSurfaces`, `nLayers` | `addLayersControls` block; omit for no layers |
| `symmetryDomain` | `true` (default) writes the outer `world` patch as `symmetry` |
| `minVol`, `maxNonOrtho` | `meshQualityDict`; `minVol` is absolute (rule ≈ `h_min³/6`) |

The scaffold writes a case in metres (`convertToMeters 1`) while STL stays in mm —
hence geometry `scale 0.001` and `locationsInMesh` in metres.

## 5. New tool or changed description

Tools are registered in `index.js`:

```js
register({
  name: 'stl_foo',
  description: 'What it does, when to call it, what it returns.',
  parameters: { stl: { type: 'string', description: '…' } },
  async execute(args, config) { … return { ok: true, … } }
});
```

`parameters` is a per-property schema; return JSON-safe values (the wrapper turns
`-0` into `0`, `Infinity`/`NaN` into `null`). The model routes on `name`,
`description` and the skill's `whenToUse` — keep them short and specific.

After any change: `node --check index.js`, run the smoke test, then reload the
bundle (disable → enable). A repeated `enabled: true` does not re-import the module.
