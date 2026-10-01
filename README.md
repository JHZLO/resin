# resin

[![CI](https://github.com/JHZLO/resin/actions/workflows/ci.yml/badge.svg)](https://github.com/JHZLO/resin/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A small language for entity-relationship diagrams.**

resin describes a database schema the way you read DDL: columns, keys, nullability, physical and
logical references, indexes, encrypted columns, audit tables. It checks what you wrote and draws it,
either as Mermaid `erDiagram` source or as its own SVG, where every foreign key row is wired to the
primary key it points at.

**[Try it in the playground](https://jhzlo.github.io/resin/)** | [Language reference](docs/SPEC.md) | [Contributing](CONTRIBUTING.md)

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="examples/order.aurora-dark.svg">
    <img src="examples/order.aurora-light.svg" alt="An ERD drawn by resin as frosted glass cards over an aurora: orders, order items and payments, with an external users table" width="820">
  </picture>
</p>

```erd
external table users "Accounts service" {
  id  bigint  pk
}

table orders "Customer orders" {
  id          bigint       pk
  user_id     bigint       ~> users  "Customer"  index as idx_user_id
  order_no    varchar(32)  uk as uk_order_no  "Order number"
  buyer_name  varchar?     enc  "Buyer name"
  status      varchar      enum(PENDING, PAID, CANCELED)  index as idx_status
  created_at  datetime
  updated_at  datetime
} audit envers(user_id, status)

table order_items "Order lines" {
  id          bigint  pk
  order_id    bigint  -> orders.id  index as ix_order_id
  product_id  bigint
  quantity    int
  unique(order_id, product_id) as uk_order_product
}
```

## Why

Mermaid's `erDiagram` is great for sketches, but it has no place for many facts a schema carries.
It does not model nullability. It cannot say whether a reference is a real `FOREIGN KEY` or only an
application-level one, or which column points where; relationship lines join tables, not columns.
Indexes, enum values and encrypted columns end up in comment strings, written by convention and
checked by nobody.

resin turns those conventions into syntax. Because the facts are structured, they can be checked
(a reference to a missing table is an error, not a typo in a comment), and they can be drawn
precisely.

## Features

- **Facts as syntax.** `varchar?` is nullable. `->` is a physical foreign key, `~>` a logical one.
  `uk`, `index`, `enum(...)`, `enc` and composite `unique(...)` are modifiers, not comments.
- **References are checked.** Missing tables and columns, nullable primary keys, duplicate names
  and type mismatches are reported with a line, a column and a hint on how to fix them.
- **Outside tables.** `external table` declares a table owned by another service, so references to
  it are checked too and the boundary shows up in the diagram.
- **Audit tables in one line.** `audit envers(...)` generates Hibernate Envers `*_aud` and
  `revinfo` tables.
- **Two outputs.** Mermaid, for anywhere Mermaid renders (GitHub, docs sites). SVG, drawn by resin
  with column-level connectors: plain ink that reads on light and dark pages, or frosted glass in
  three themes (aurora, silk, caustic), each dark or light. In the playground the glass is live: the
  background moves and the glass catches the light under your pointer.
- **Deterministic.** The same input gives byte-identical Mermaid and SVG.
- **No runtime dependencies.** The SVG renderer takes an [ELK](https://github.com/kieler/elkjs)
  instance that you pass in.

## Getting started

resin is not on npm yet. It needs Node 22.18 or newer (the sources are TypeScript run directly by
Node) and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/JHZLO/resin.git
cd resin
pnpm install
```

Compile a file to Mermaid, or draw it as SVG:

```bash
pnpm resin examples/order.erd
pnpm resin examples/order.erd --svg > order.svg
pnpm resin examples/order.erd --svg --look aurora-dark > order.aurora-dark.svg
pnpm resin examples/shop.erd --svg --keys > shop.svg
```

Errors come out in compiler format:

```text
schema.erd:3:26: error: referenced table `user` is not in this document
  |
3 |   user_id     bigint  ~> user
  |                          ^^^^
  = hint: declare it with `external table` if it lives outside this document
```

## Using the library

```ts
import ELK from "elkjs";
import { compile, formatDiagnostic, toSvg } from "./src/index.ts";

const result = compile(source);
for (const d of result.diagnostics) console.error(formatDiagnostic(d, source, "schema.erd"));

if (result.model) {
  console.log(result.mermaid); // Mermaid erDiagram source
  const { svg } = await toSvg(result.model, new ELK(), { standalone: true });
}
```

`compile` returns the syntax tree, the diagnostics, and, when there are no errors, the resolved
model and its Mermaid source. `toSvg` draws a model; options choose the look (`graphite`, the
default, or a glass theme such as `aurora-dark`), all columns or key columns only, and folded or
expanded audit tables.

## The language at a glance

| You write | It means |
|---|---|
| `name varchar(32)?` | A nullable column. Without `?` it is NOT NULL |
| `pk`, `uk`, `uk as uk_name` | Primary key, single-column unique (optionally named) |
| `-> table.column`, `~> table` | Physical foreign key; logical reference (defaults to the primary key) |
| `index`, `index as ix_name` | An index starting at this column |
| `enum(A, B)`, `enc` | Allowed values; stored encrypted |
| `unique(a, b) as uk_ab`, `index(a, b)` | Composite constraints |
| `external table t { ... }` | A table owned elsewhere that you can reference |
| `} audit envers(a, b)` | Hibernate Envers audit tables for the listed columns |
| `` `order-items` `` | A name with characters outside `[A-Za-z0-9_]` |

The full grammar, the rules for cardinality and the Mermaid mapping are in the
[language reference](docs/SPEC.md).

## Status

resin is young and pre-1.0. The grammar may still change between minor versions; when it does, the
parser recognizes the old form and tells you how to write it now. See the [changelog](CHANGELOG.md).

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) explains how the project
is laid out and how a grammar change goes from the spec to the implementation.

## License

[MIT](LICENSE)
