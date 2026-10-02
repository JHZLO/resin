# Library

resin is a library first: the playground and the command line are both small programs around it. It is not on npm yet, so import it from a clone; Node 22.18 or newer runs its TypeScript sources directly.

```ts
import { readFile } from "node:fs/promises";
import ELK from "elkjs";
import { compile, formatDiagnostic, toSvg } from "./resin/src/index.ts";

const source = await readFile("schema.erd", "utf8");
const result = compile(source);
for (const d of result.diagnostics) console.error(formatDiagnostic(d, source, "schema.erd"));

if (result.model) {
  console.log(result.mermaid);
  const { svg } = await toSvg(result.model, new ELK(), { look: "aurora-dark" });
}
```

## compile(source)

Parses, checks and resolves a document in one step. It returns:

| Field | What it holds |
|---|---|
| `doc` | The syntax tree, with a position on every node |
| `diagnostics` | Errors and warnings, in source order |
| `model` | The resolved model: tables, columns and relations. `null` when there is an error |
| `mermaid` | The Mermaid source. `null` when there is an error |

`formatDiagnostic(d, source, file)` prints one diagnostic in compiler format, and `hasErrors(diagnostics)` tells whether any of them is an error.

## toSvg(model, elk, options)

Draws a model and resolves to `{ svg, width, height, background, boxes }`. `boxes` gives every card's position, for pages that decorate or navigate the drawing; `background` is the look's base color, or `null` for `graphite`. The options are listed on the [SVG](svg.md) page.

resin itself has no runtime dependencies. Layout needs [elkjs](https://github.com/kieler/elkjs), which you pass in, so code that only needs Mermaid never loads it.

## Lower-level steps

`parse`, `check`, `lower` and `toMermaid` are the steps `compile` runs, exported for tools that need one of them on its own: an editor that wants the syntax tree, say, or a linter that only checks.
