## What and why

<!-- One paragraph: the change and the reason for it. -->

## Evidence

<!-- The run that supports the claim: command, key numbers, verdict. "Numbers come from a run." -->

- [ ] `node scripts/check-catalogue.mjs`
- [ ] `node scripts/check-versions.mjs` (version + CHANGELOG + README banner bumped together)
- [ ] `npm test`
- [ ] `node scripts/contract-test.mjs --no-mesh` (and the full suite if OpenFOAM is available)
- [ ] `node scripts/make-index.mjs` if this is a release commit (index re-pinned)

## Notes for the reviewer

<!-- Skips, known gaps, anything you could not verify in your environment. -->
