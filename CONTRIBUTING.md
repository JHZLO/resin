# Contributing to resin

Thanks for taking the time. Bug reports, grammar ideas and pull requests are all welcome.

## Setup

You need Node 22.18 or newer and [pnpm](https://pnpm.io). There is no build step for the library:
Node runs the TypeScript sources directly.

```bash
pnpm install
pnpm check                      # typecheck and all tests; must pass before a commit
pnpm test                       # tests only
pnpm test -u                    # update golden files (examples/*.mmd, *.svg) after reviewing the diff
pnpm resin examples/order.erd   # Mermaid on stdout, diagnostics on stderr
pnpm resin examples/order.erd --svg > order.svg
pnpm build:site                 # build the landing page, the docs and the playground into site/
```

## How the code is laid out

```
source ──lex──> tokens ──parse──> syntax tree ──check──> diagnostics
                                        └──lower──> model ──> Mermaid / SVG
```

| File | Role |
|---|---|
| `docs/SPEC.md` | **The definition of the language**: lexical structure, grammar, semantics, Mermaid mapping, SVG rules |
| `src/lexer.ts` | Tokens. Keywords are plain idents; the parser decides from context |
| `src/parser.ts` | Hand-written recursive descent parser. Drops a broken line and keeps reading |
| `src/checker.ts` | Semantic checks: missing references, duplicates, nullable keys, audit rules |
| `src/model.ts` | Resolves references, cardinality and audit tables once, for every output |
| `src/mermaid.ts` | Mermaid `erDiagram` output |
| `src/svg.ts` | SVG output, laid out with ELK: `graphite`, or glass in three themes (`aurora`, `silk`, `caustic`), dark or light |
| `src/index.ts` | The public API (`compile`, `toSvg`, ...) |
| `src/cli.ts` | Command-line entry |
| `playground/` | The web playground. `glass.ts` paints the live glass canvas with WebGL |
| `docs/guide/` | The docs, one Markdown page each. `` ```erd example `` blocks are drawn by resin when the site is built |
| `website/` | The landing page's and the docs' style and script, and the code highlighter |
| `scripts/build-site.mjs` | Builds `site/`: the landing page, the docs and the playground, for GitHub Pages |
| `examples/` | Example schemas and their golden output (`order.aurora-dark.svg` and `order.aurora-light.svg` cover the glass). A new `.erd` file gets golden tests automatically |

## Changing the grammar

A grammar change goes **spec, then tests, then implementation**, in that order.

1. Update `docs/SPEC.md`: every section it touches (lexical structure, grammar, semantics, Mermaid
   mapping, diagnostics).
2. Write tests for **valid and invalid input**. For invalid input, pin the message and the span.
3. Implement it: `lexer.ts` → `parser.ts` → `checker.ts` → `model.ts` → `mermaid.ts` / `svg.ts`,
   as far as the change reaches.
4. Use the new syntax in an example under `examples/`. Review the golden diff, then `pnpm test -u`.
5. Update the page under `docs/guide/` that covers the construct.
6. Make sure `pnpm check` and `pnpm build:site` pass. The site build compiles every example in the
   docs and stops on any that does not compile cleanly.

If a change would break existing files, let the parser recognize the old form and answer it with a
hint (see SPEC §8).

## Design principles

Check new syntax against these. If a change bends one of them, open an issue to discuss it first.

- **One fact, one form.** The same fact should not be writable in two ways (a single-column
  `unique(x)` is a warning because `uk` exists).
- **No facts in strings.** Descriptions are for people. Anything a tool needs to know is syntax.
  Encoding facts in comment strings is the problem resin exists to solve.
- **Position decides.** Keywords are contextual, not reserved. A new keyword must not stop an
  existing name (a column called `index`) from working; add a parser test for that case.
- **Read like DDL.** Columns are `name type`, types are physical types. Someone who reads schemas
  should be able to read resin without learning much.
- **Diagnostics point and help.** Every diagnostic has an exact span and, where possible, a hint.
  The parser reports several errors per run. Semantic checks do not run on broken syntax.
- **Deterministic output.** The same input gives byte-identical output. Orders come from the
  document, never from locale-aware sorting or map iteration. Text is never measured.
- **Mermaid is one backend.** Do not shrink the language to what Mermaid can draw.

## Code style

- Node runs `.ts` files through type stripping, so only erasable syntax is allowed: no `enum`, no
  `namespace`, no constructor parameter properties (`erasableSyntaxOnly` enforces this). Relative
  imports include the `.ts` extension; type-only imports use `import type`.
- The library has **no runtime dependencies**. Development dependencies are fine.
- Comments explain why, not what. Test names describe behavior.

## Commits

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): Subject`, imperative,
capitalized, no trailing period, at most 70 characters. Types: `feat` `fix` `refactor` `perf`
`docs` `test` `build` `ci` `chore` `style`. Scopes are usually a module: `parser`, `checker`,
`svg`, `playground`, `spec`.
