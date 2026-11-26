# Version and DSH compatibility policy

Three questions this document answers: which DSH versions the bundle accepts, what counts as a
breaking change for a consumer, and how a version travels through the repository.

## 1. What the bundle declares

`package.json` at the repository root is the single source of truth — the bundle installs as one
package (`mesh-toolkit`), and the three trees inside it (`sim-core`, `mesh-stl`, `mesh-build`) are
not published separately.

| Field | Value | Meaning |
|---|---|---|
| `engines.node` | `>=20` | Node built-ins only (`node:test`, `fs`, `path`); no runtime dependencies. |
| `engines.dsh` | `>=0.2.2-rc.1 <0.3.0` | DSH majors are the compatibility boundary: a DSH `0.3.x` may change the plugin API. |
| `peerDependencies['@deepseek-ai/cordis']` | `^4.0.5` | Cordis 4 services (`tools.register`, `systemPrompt`, `skills`). |
| `peerDependencies['@deepseek-ai/dsh-tools']` | `>=0.2.2-rc.1 <0.3.0` | Tool registration contract. |
| `peerDependencies['@deepseek-ai/dsh-skill']` | `>=0.2.2-rc.1 <0.3.0` | Skill registration contract. |
| `dsh.bundle.patch` | `./cordis.patch.yml` | The bundle manifest a market index requires. |

The bundle is tested against the DSH release the maintainer runs, currently **0.2.x**. The range
above is a claim of API compatibility, not a test matrix: a new DSH major needs a run of
`node scripts/contract-test.mjs` before the range is widened.

## 2. What a plugin version promises

A change is **breaking** for a consumer when it alters any of:

- a tool name (`mesh_build`, `stl_check`, …) or a required argument;
- the shape of a tool result a caller branches on (`verdict`, `ok`, `error`, `next`,
  `needs_input`, `versionInfo`);
- `handoff.json` (`mesh-handoff/1`) or the request/feedback schemas (`mesh-request/1`,
  `mesh-feedback/1`) documented in [`WORKBENCH-CONTRACT.md`](WORKBENCH-CONTRACT.md);
- the `meshToolkit` service shape (`apiVersion: 1`) or the ids of knowledge cards other tools
  reference by name.

Breaking changes bump the **minor** while the bundle is `1.x` (all three packages are versioned
together from `1.0.0-rc.1` on), and the `CHANGELOG.md` of the touched package must say what a
consumer has to do. Additive changes (new tool, new card, new optional argument, a new
`next[]` entry) bump the **patch**.

The pre-1.0 tags (`0.5.x` … `0.7.5`) predate this policy; their CHANGELOGs remain the record.

## 3. How a version travels

1. Edit the code in this repository, then bump `version` in the root `package.json` **and** in the
   touched tree's `package.json` (`mesh-build/package.json`, `mesh-stl/package.json`,
   `sim-core/package.json`) — the trees carry their own version for display in `versionInfo`.
2. Add a `CHANGELOG.md` heading `## <version> — <YYYY-MM-DD>` to every touched tree.
3. Update the banner in `README.md`: `> **<version>** · packages: …`.
4. `node scripts/check-versions.mjs` — it fails when package.json, CHANGELOG and the banner disagree,
   and it accepts prerelease suffixes (`1.0.0-rc.2`).
5. `node scripts/make-index.mjs` — regenerates `market/index.json` pinned to the commit that will be
   tagged, and validates it with the official `@deepseek-ai/dsh-plugin-market-index` parser.
6. Commit, tag `v<version>`. The tag drives `.github/workflows/release.yml`: notes come from
   `docs/RELEASE-<version>.md`, three tarballs are attached, and a tag containing `-` is published
   as a prerelease.

## 4. When a DSH release breaks the bundle

The failure surfaces at load time (`ctx.tools.register` throwing, a missing service) or in the
contract tiers. The procedure:

1. Reproduce with the installed DSH; note the DSH version and the exact error.
2. Run `node scripts/contract-test.mjs` — the library tier needs no OpenFOAM and pins most of the
   API surface.
3. Fix or declare the new range in `engines.dsh` and the peers, keeping the old range only if the
   contract suite passes on both.
4. Record the measurement in `CHANGELOG.md` (what DSH version, which test), not in prose elsewhere.

Old DSH versions are supported until the next DSH major: the bundle never silently narrows a range
to make CI pass — narrowing is a breaking change and follows §2.

## 5. Node

`>=20` is required (`node --test`, `fs.rmSync`, `structuredClone`). CI runs the checks on Node 20
and 24; a feature that needs a newer Node must raise `engines.node` in the same commit.
