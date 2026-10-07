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
  const { svg } = await toSvg(result.model, new ELK(), { look: "aurora-dark" });
  console.log(svg);
}
```

## compile(source)

Parses, checks and resolves a document in one step. It returns:

| Field | What it holds |
|---|---|
| `doc` | The syntax tree, with a position on every node |
| `diagnostics` | Errors and warnings, in source order |
| `model` | The resolved model: tables, columns and relations. `null` when there is an error |

`formatDiagnostic(d, source, file)` prints one diagnostic in compiler format, and `hasErrors(diagnostics)` tells whether any of them is an error.

## toSvg(model, elk, options)

Draws a model and resolves to `{ svg, width, height, background, boxes }`. `boxes` gives every card's position, for pages that decorate or navigate the drawing; `background` is the look's base color, or `null` for `graphite`. A service drawn folded (the `fold` option) has one box, whose `table` is `serviceCardId(service)`: `service` and the service's name in backticks, as in `` service `ordering` ``. The options are listed on the [SVG](svg.md) page.

resin itself has no runtime dependencies. Layout needs [elkjs](https://github.com/kieler/elkjs), which you pass in, so code that only checks a document never loads it.

## lint(doc)

Checks a document that compiled without errors against the [lint rules](lint.md) and returns their findings: warnings, in source order, each with the name of its rule in `rule`. `LINT_RULES` lists the rules.

```ts
const result = compile(source);
const findings = result.model ? lint(result.doc) : [];
```

## diff(before, after)

Compares two models. Returns `model`, the newer model with what is gone put back and every added, removed or changed table, column and relation marked with `change: { kind, details }`, which `toSvg` draws in color; and `changes`, the list of them. `diffMarkdown(changes)` writes the list as Markdown. See [Comparing versions](diff.md).

```ts
const { model, changes } = diff(compile(older).model!, compile(newer).model!);
const { svg } = await toSvg(model, new ELK());
console.log(diffMarkdown(changes));
```

## format(source)

Writes a document in resin's one layout, as `resin fmt` does; [Formatting](formatting.md) describes it. Returns `text`, the formatted document, and `diagnostics`, empty unless the source has syntax errors, in which case `text` is `null`. Only whitespace changes, and the result parses to the same document.

```ts
const { text, diagnostics } = format(source);
if (text !== null) await writeFile("schema.erd", text);
```

## toSql(model, options)

Writes a model as SQL DDL; [Generating SQL](generating-sql.md) describes it. `options.dialect` is one of `SQL_DIALECTS` (`mysql`, `postgres`, `sqlite`, `sqlserver`, `oracle`), and `options.service` limits it to one service's tables, for that service's own database. Returns `sql` and `notes`, the lines that say what was written in an unexpected way. Throws when the document has no such service.

```ts
const { sql, notes } = toSql(compile(source).model!, { dialect: "postgres" });
```

## fromSql(sql, options)

Converts SQL DDL to resin source, as the playground does on paste; [Importing SQL](sql.md) lists the rules. It returns:

| Field | What it holds |
|---|---|
| `source` | The resin source. Empty when the SQL creates no table |
| `notes` | What did not convert, or converted with a caveat: `{ message, line, col }`, positions in the SQL |
| `tables` | How many tables were converted, not counting the external tables added for references |

| Option | What it does |
|---|---|
| `known` | Names of tables already in the document the result goes into. References to them point at them instead of adding external tables |
| `inferReferences` | Also read `<table>_id` columns without a foreign key as logical references (`~>`) |

`looksLikeSql(text)` tells whether a text is SQL that creates a table, for deciding when to convert.

## neighbors(model, table, steps)

The part of a model within `steps` references of one table: that table, the tables it references and the ones referencing it (one step), their neighbors too (two steps), and every relation among them. Columns keep their references to the tables left out, so `toSvg` still marks them as foreign keys. The playground's related view draws this.

```ts
const part = neighbors(result.model, "orders", 1);
const { svg } = await toSvg(part, new ELK());
```

## Lower-level steps

`parse`, `check` and `lower` are the steps `compile` runs, exported for tools that need one of them on its own: an editor that wants the syntax tree, say, or a linter that only checks.

## Table identities and composite relations

A service-owned table has a qualified `name`, such as `billing.orders`, and a short `label`. Use `name` for relationships and `neighbors`, and `label ?? name` for display. Unscoped names containing a dot are quoted in their identity to avoid colliding with a service-qualified table.

A composite FK remains one entry in `model.relations`. Read `childColumns ?? [childColumn]` and `parentColumns ?? [parentColumn]` as ordered pairs. `constraint` stores its optional name. `ModelTable.foreignKeys` lists the composite declarations.
