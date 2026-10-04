# Quality checks

Run these commands before publishing a change:

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm exec playwright install chromium firefox webkit
pnpm build:site
pnpm test:browser
```

On Linux, use `pnpm exec playwright install --with-deps chromium firefox webkit`.
The browser suite serves the built `site/` directory on loopback port 4173. Set `RESIN_TEST_PORT` to use another port. It starts its own server so it cannot test a different checkout by mistake. Rebuild after source changes.
Failures save a screenshot and trace under `test-results/`; CI uploads that directory.

## Automated coverage

| Layer | Checks |
|---|---|
| Language and SQL | Valid and invalid schemas, diagnostic positions, five DDL dialect fixtures, qualified and quoted identifiers, composite references, deterministic output |
| Comparison and CLI | Reference changes, missing files, invalid arguments, help, stdout and stderr boundaries |
| PR Action | Divergent base branches, merge-base lookup, added, removed and renamed paths, unusual filenames, identical reruns, concurrent branch updates, paginated comments, restricted token fallback |
| Playground state | IndexedDB migration, recovery records, transaction rollback, stale-tab conflicts, bounded view caches, comment-only analysis, malformed saved values, share decoding, same-document view changes, empty comparison bases, reload recovery |
| Browser workflows | DDL paste conversion and undo, import review and reimport, named documents and reload, storage failure and source download, reading links, saved views, relation focus, folded-column navigation, narrow layouts, keyboard focus |
| Rendering | Fit and gesture calculations, context restoration, reduced-motion refresh, static fallback, escaped descriptions, large schemas, layout cancellation and document switching |

Browser tests run on Chromium, Firefox and WebKit. Load cases run on Chromium only and record elapsed render time for 10, 100 and 500-table schemas. Full-column cases use 24 columns per table and cover a 500-table chain and a 500-table hub. The hub case has a 15-second end-to-end test budget, including page startup. Tests also assert that comment edits preserve mounted SVG, background changes avoid layout work, and returning to All reuses its layout and DOM. An animation-enabled smoke test covers composite-key focus and zoom. These synthetic budgets detect regressions; they are not a universal performance guarantee.

Performance cases retain action traces and failure screenshots, but omit per-action DOM snapshots. Copying a large drawing into the trace at every step can dominate the operation being measured. Recovery tests wait for both committed storage and the recovered drawing before reloading.

DDL paste tests dispatch clipboard events with fixture text. They test the editor conversion path; they do not test DataGrip or operating-system clipboard integration. WebGL lifecycle unit tests use a controlled stub.

## Manual release checks

- Copy DDL from DataGrip and paste it into a blank editor and an existing document. Inspect notes and undo both steps.
- Check all three backgrounds in light and dark modes. Drag, zoom and select keys with motion enabled, then repeat with reduced motion.
- Check real touch pinch and drag, browser tab suspension, display scale changes and GPU context recovery on representative hardware.
- Open a shared link in a fresh browser profile. Confirm its filters and comparison, then export and inspect the SVG.
- Check 375px and tablet layouts with the editor, search, column popover and table panel open.
- Test a fork pull request with restricted credentials in a disposable repository. Confirm the comparison appears in the job summary when posting is unavailable.

## Release evidence

Record the commit SHA, runtime versions, test results and remaining manual checks. Verify both CI and Site for that SHA, then open the deployed docs and playground. A successful local build alone does not confirm deployment.
