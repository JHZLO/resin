# resin language reference (v0.2)

resin is a small language for entity-relationship diagrams. It records the facts a schema carries
(nullability, keys, physical and logical references, indexes, encryption, audit tables) **as syntax
rather than as comment conventions**, checks them, and draws them: as Mermaid `erDiagram` source
and as resin's own SVG.

This document is the definition of the language. When the implementation (`src/`) disagrees with
it, the implementation is wrong.

## 1. Overview

```erd
%% Orders
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
  product_id  bigint  "Product in the catalog service"
  quantity    int
  created_at  datetime
  unique(order_id, product_id) as uk_order_product
}
```

## 2. Lexical structure

| Element | Form | Notes |
|---|---|---|
| Identifier | `[A-Za-z_][A-Za-z0-9_]*` | Tables, columns, types, names, enum values |
| Backtick identifier | `` `...` `` | Any characters except a backtick or a newline. For hyphens, spaces, Hangul. Never a keyword |
| Number | `[0-9]+` | Only in type arguments and enum values |
| String | `"..."` | Two escapes: `\"` and `\\`. Must end on the same line |
| Comment | `%%` to the end of the line | As in Mermaid |
| Punctuation | `{ } ( ) , . ?` | |
| Reference arrows | `->` `~>` | Physical FK / logical reference |
| Newline | `\n` | **Ends a statement.** Ignored inside parentheses |

Keywords (`table` `external` `pk` `uk` `enc` `enum` `index` `unique` `as` `audit`) are
**contextual**: they are not reserved, so a column may be called `index`; the position decides.
A backtick name is never a keyword. `` `users` `` and `users` are the same name.

A name made of non-ASCII letters must be written in backticks (`` `주문` ``); the lexer reports it
once and suggests the backticks.

## 3. Grammar (EBNF)

```ebnf
document    = { NL | table } EOF ;
table       = [ "external" ] "table" name [ STRING ] "{" { member | NL } "}" [ audit ] ( NL | EOF ) ;
member      = constraint | column ;

column      = name type { modifier } ( NL | "}" ) ;   (* "}" is not consumed, for one-line tables *)
type        = IDENT [ "(" NUMBER { "," NUMBER } ")" ] [ "?" ] ;
modifier    = "pk" | "enc"
            | "uk" [ "as" name ]
            | "index" [ "as" name ]
            | "enum" values
            | ( "->" | "~>" ) name [ "." name ]
            | STRING ;

constraint  = ( "unique" | "index" ) list [ "as" name ] ;  (* only when "(" directly follows the keyword *)
audit       = "audit" IDENT [ list ] ;
list        = "(" [ name { "," name } [ "," ] ] ")" ;
values      = "(" [ value { "," value } [ "," ] ] ")" ;
value       = name | NUMBER ;
name        = IDENT | QUOTED ;
```

## 4. Semantics

### 4.1 Tables

- `table name ["description"] { ... }`: names are unique within a document, external tables
  included. The description is for people.
- `external table name ["description"] { ... }`: a table that lives **outside this document**
  (another service, another database). List only the columns you point at, usually the primary
  key. It receives references and is checked like any other table. Its columns cannot hold
  references (`->`, `~>`), and it cannot have `audit`.

### 4.2 Columns

`name type[?] modifiers...`: the name comes first, as in SQL DDL.

- The **type** is a physical type name, optionally with arguments: `bigint`, `varchar(32)`,
  `decimal(12,2)`. Arguments are kept as written and may be left out.
- **`?`** marks a nullable column (`varchar?`, `varchar(32)?`). No `?` is a positive claim that
  the column is NOT NULL.
- Modifiers come in any order. Writing the same modifier twice is an error.

| Modifier | Meaning |
|---|---|
| `pk` | Primary key. On several columns: a composite primary key. Cannot be combined with `?` |
| `uk` / `uk as name` | Single-column UNIQUE |
| `enc` | Stored encrypted |
| `enum(A, B)` | Allowed values: names or numbers (`enum(0, 1, 2)`). Write only values the schema or its comments support |
| `index` / `index as name` | An index whose first column is this one. Leave out `as` when the name is unknown |
| `-> t.c` | Physical FK: the database declares a `FOREIGN KEY` constraint |
| `~> t.c` | Logical reference: the application treats it as a reference, the database has no constraint |
| `"..."` | A description for people. **Descriptions carry no facts**: anything a modifier can say goes in a modifier |

### 4.3 References and cardinality

- A reference is **attached to a column**. There are no separate relationship lines.
- Without `.c`, the reference points at the target's primary key, which must be a single column.
- The target must be a `table` or an `external table` of the same document.
- **How many**: when the referencing column has `uk`, or is the table's only primary key, the
  relation is one-to-one; otherwise one-to-many.
- **Whether a parent must exist**: a NOT NULL referencing column means every child has exactly
  one parent; a `?` column means zero or one.
- When the type name differs from the target column's type name, a warning is reported. Type
  arguments (lengths) are not compared.

### 4.4 Names (`as`)

Index and unique constraint names follow `as`. Parentheses only ever hold lists.

- On a column: `uk as uk_order_no`, `index as idx_user_id`
- On a table constraint: `unique(a, b) as uk_ab`, `index(a, b) as ix_ab`

A name used twice within one table is an error.

### 4.5 Table constraints

Written as a line inside the table block. A constraint starts only when `(` directly follows the
keyword, so `index int` is a column called `index`.

- `unique(a, b)` / `unique(a, b) as name`: composite UNIQUE
- `index(a, b)` / `index(a, b) as name`: composite index

For a single column use the column modifiers `uk` and `index`; a single-column constraint is
reported as a warning.

### 4.6 Audit tables (`audit`)

Declares audit tables in one line. `audit` is followed by a **method**; the only method today is
`envers` (Hibernate Envers).

- `} audit envers(c1, c2)`: `<table>_aud` holds the primary key, `rev`, `revtype` and the listed columns.
- `} audit envers`: every column except the primary key, `created_at` and `updated_at`.
- As soon as one table uses `audit envers`, a `revinfo` table and its relations are generated.
  Declaring `revinfo` or `<table>_aud` yourself is therefore an error.
- Not allowed on tables without a primary key, nor on external tables.

## 5. Mermaid mapping

| resin | Mermaid `erDiagram` |
|---|---|
| `table t "description"` | `t["t (description)"] { ... }`; without a description `t { ... }` |
| `external table u` | `:::external` on the block line and `classDef external stroke-dasharray:4 3` at the end |
| `a_id bigint -> a.id` (in `b`) | `a \|\|--o{ b : "a_id"` and the attribute `bigint a_id FK "-> a.id"` |
| `~>` | Dotted line `..` |
| One-to-one reference | Right end `o\|` |
| Nullable referencing column | Left end `\|o` |
| Type | As written: `varchar(32)?` |
| `pk`, `uk`, reference | Key markers `PK`, `UK`, `FK` (in the order PK, FK, UK) |
| Description, `enc`, `enum` | Attribute comment: `"description (enc) A/B"` |
| Reference target | Then `; -> a.id` |
| `index` / `index as n`, `uk as n` | `(ix)` / `(n)` at the end of the comment |
| `unique(a, b)` / `unique(a, b) as n` | `uk(a,b)` / `n(a,b)` in the comment of the first column |
| `index(a, b)` / `index(a, b) as n` | `ix(a,b)` / `n(a,b)` in the comment of the first column |
| `audit envers` | A `revinfo` block, `<table>_aud` blocks and `revinfo \|\|..o{ <table>_aud : "Envers rev"` |

### 5.1 Names

Mermaid cannot read some names as they are (measured with Mermaid 11.16).

- A **table name** that is not a plain ASCII identifier, or is a Mermaid keyword (`class`
  `classDef` `style` `erDiagram` `direction` `accTitle` `accDescr` `title` `to` `one` `many`,
  case-insensitive), is written in double quotes.
- A **column name** cannot be quoted in Mermaid. Characters other than letters, digits, `_` and `-`
  become `_`; a leading digit or `-` gets a `_` prefix; `pk`, `fk` and `uk` (case-insensitive) get
  a `_` suffix. When a name had to change, its original is written in backticks at the start of
  its comment.
- A `"` inside a string becomes `#quot;`, because Mermaid has no `\"` escape.

### 5.2 Output order

`erDiagram` → a legend comment (when there are references) → domain relations (in document order
of the child table and column) → a blank line → audit relations → entity blocks (document order,
external tables included) → `revinfo` → `*_aud` → `classDef`. The same input always yields
byte-identical output.

## 6. SVG rendering

`toSvg(model, elk, options)` draws the model itself. Layout uses [ELK](https://eclipse.dev/elk/)'s
layered algorithm with a port on every column row, so each connector runs from a foreign key row to
the primary key row it points at.

- **Cards**: the table name and description in the header, then one row per column: a key label
  (`PK`, `UK` or `FK`) in a gutter, the column name, its description, and the type at the right edge
  (with `?` for nullable columns, the drawing's one accent color). Notes in plain faint words (`fk`
  on a primary key that is also a reference, `enum`, `enc`, `index`) sit before the type. Composite
  constraints are listed under the rows. Corners are small (8 units) and the edge is one even line.
  Keys are told apart by weight: `PK` reads strongest, `UK` and `FK` step back.
- **Connectors**: orthogonal with tight bends. Solid for physical FKs, dashed for logical
  references. A chevron at the primary key end, as in `->`; a square port and `N` (one-to-many) or
  `1` (one-to-one) at the foreign key end. Nullability is shown by the `?` on the foreign key row
  rather than at the chevron, because many relations can share one primary key. `edges: "curved"`
  draws S-bends with level ends instead, and keeps the routed path, with wide bends, wherever an
  S-bend would cross another card.
- **External tables** have a dashed border and the note `external` in the header. **Audit tables**
  are folded into the note `audited, envers` by default; `audit: "expand"` draws `revinfo` and
  `*_aud` as tables.
- `columns: "keys"` shows only key and reference columns and folds the rest into `+N columns`.
- **Looks** (`look`), one layout and one card anatomy:
  - `plain` (the default) paints no background. Ink is `currentColor` with a fixed ramp of
    opacities, so the drawing reads on any page. `standalone: true` adds a `<style>` that picks the
    ink color from `prefers-color-scheme`, for SVG files embedded with `<img>`.
  - `dark` and `light` draw solid cards with a soft shadow on a quiet stage: a base color, one faint
    glow and a dot grid. Nothing in it is decoration and nothing moves. `toSvg` returns the stage's
    base color as `background` (`null` for plain).
- **Live canvases**: `stage: false` leaves the stage out and keeps the cards, so a page can paint
  the stage itself and let it reach past the drawing, as the playground does. `toSvg` returns every
  card's position as `boxes`. `idPrefix` (default `rz-`) prefixes every id, so several drawings can
  share a page.
- **Hooks for viewers**: a table is `g.rz-t[data-t]`, its header `g.rz-head`, a column row
  `g.rz-c[data-c]`, a connector `g.rz-r` with `data-a`/`data-ac` (primary key side) and
  `data-b`/`data-bc` (foreign key side). A table's shadow (`.rz-s`) carries the same `data-t`, the
  header and every row have a transparent hit area (`.rz-hit`) to tint on hover, and the stage's dot
  grid is `.rz-grid`, so a viewer can fade a table or hide the grid with CSS alone.
- **Deterministic**: text is never measured. Widths follow fixed rules (monospace: 0.6em per
  cell; proportional: 0.57em per Latin letter, 1em per CJK character), so the same input yields the
  same SVG in a browser and on the command line.

## 7. Diagnostics

Every error and warning has a `line:column` position, and most have a hint. The parser skips the
line an error is on and keeps going, **so one run reports several errors**. When there are syntax
errors, semantic checks do not run (they would report bogus follow-up errors). When there is any
error, no model and no output are produced.

## 8. Migrating from v0.1

The parser recognizes v0.1 syntax and says how to write it in v0.2.

| v0.1 | v0.2 |
|---|---|
| `erd` on the first line | Delete it |
| `index(idx_name)` | `index as idx_name` |
| `unique name(a, b)` / `index name(a, b)` | `unique(a, b) as name` / `index(a, b) as name` |
| `} audit(a, b)` / `} audit` | `} audit envers(a, b)` / `} audit envers` |
| An outside reference written as a description | Declare an `external table` and use `~>` |
