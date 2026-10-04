# resin language reference (v0.2)

resin is a small language for entity-relationship diagrams. It records the facts a schema carries
(nullability, keys, physical and logical references, indexes, encryption, audit tables) **as syntax
rather than as comment conventions**, checks them, and draws them as SVG.

This document is the definition of the language. When the implementation (`src/`) disagrees with
it, the implementation is wrong.

## 1. Overview

```erd
%% Orders
group accounts "Accounts service" {
  external table users "People who sign in" {
    id  bigint  pk
  }
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
  order_id    bigint  -> orders.id
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
| Comment | `%%` to the end of the line | |
| Punctuation | `{ } ( ) , . ?` | |
| Reference arrows | `->` `~>` | Physical FK / logical reference |
| Newline | `\n` | **Ends a statement.** Ignored inside parentheses |

Keywords (`group` `table` `external` `pk` `uk` `enc` `enum` `index` `unique` `as` `audit`) are
**contextual**: they are not reserved, so a column may be called `index`; the position decides.
A backtick name is never a keyword. `` `users` `` and `users` are the same name.

A name made of non-ASCII letters must be written in backticks (`` `주문` ``); the lexer reports it
once and suggests the backticks.

## 3. Grammar (EBNF)

```ebnf
document    = { NL | group | table } EOF ;
group       = "group" name [ STRING ] "{" { table | NL } "}" ( NL | EOF ) ;
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

### 4.7 Groups (`group`)

`group name ["description"] { tables }` puts the tables written inside it in a named group: a
service, a domain, any part of a schema that belongs together. The description is for people.

- A group holds `table` and `external table` blocks and nothing else. An external table in a group
  says which outside service owns it.
- Groups do not nest, and a table belongs to at most one group. Tables outside every group belong to
  none.
- Group names are unique within a document. They are names of their own: a group may share its
  name with a table.
- Grouping changes nothing else: table names stay unique across the whole document, and references
  cross groups freely.
- A group with no tables is reported as a warning.
- When audit tables are drawn, `<table>_aud` belongs to the group of its table; `revinfo` belongs
  to none.

## 5. SVG rendering

`toSvg(model, elk, options)` draws the model itself. Layout uses [ELK](https://eclipse.dev/elk/)'s
layered algorithm with a port on every column row, so each connector runs from a foreign key row to
the primary key row it points at.

- **Cards**: the table name and description in the header, then one row per column: a key label
  (`PK`, `UK` or `FK`) in a gutter, the column name, its description, and the type at the right edge.
  A nullable column is marked `NULL` after its type, as in DDL; a card with any nullable column keeps
  a narrow column for it, so the types stay aligned. Tags `ENUM`, `ENC`, `IX` and `FK` sit before the
  type. Composite
  constraints are listed under the rows. Corners are small (8 units), tags are rectangles and the
  edge is one even line.
- **Connectors**: orthogonal with tight bends. Solid for physical FKs, dashed for logical
  references. A chevron at the primary key end, as in `->`; a square port and `N` (one-to-many) or
  `1` (one-to-one) at the foreign key end. Nullability is shown by the `NULL` on the foreign key row
  rather than at the chevron, because many relations can share one primary key. `edges: "curved"`
  draws S-bends with level ends instead, and keeps the routed path, with wide bends, wherever an
  S-bend would cross another card.
- **Groups** are areas around their tables, laid out by ELK as nodes that hold the cards, so a group
  keeps its tables together and connectors cross from one group to another. An area has a faint
  tint, an even edge with corners of 12 units, and its name and description at the top left. The
  tint stops at the cards, so glass painted below the SVG is never tinted. In a glass look the
  groups take hues in the order they are declared: teal, violet, amber, rose, sky, lime, then again;
  the hue is the group's place among all the groups of the model, so a part of a model keeps the
  colors of the whole. `graphite` draws groups in ink alone. A group is `g.rz-g[data-g]`.
- **External tables** have a dashed border and an `EXTERNAL` tag. **Audit tables** are folded into
  an `ENVERS` tag by default; `audit: "expand"` draws `revinfo` and `*_aud` as tables.
- `columns: "keys"` shows only key and reference columns and folds the rest into `+N columns`.
  `columns: "none"` draws the headers alone, sized to the name, with each connector between the
  middles of two headers; a header shared by several connectors gathers them there.
- **Looks** (`look`), one layout and one card anatomy in different finishes:
  - `graphite` (the default) paints no background. Ink is `currentColor` with a fixed ramp of
    opacities, so the drawing reads on any page. `standalone: true` adds a `<style>` that picks the
    ink color from `prefers-color-scheme`, for SVG files embedded with `<img>`.
  - Glass, in three themes with a dark and a light version each: `aurora-dark`, `aurora-light`
    (ribbons of light under a sky of stars), `silk-dark`, `silk-light` (folds of color) and
    `caustic-dark`, `caustic-light` (light through water). Cards are frosted liquid glass: the stage
    behind them is blurred and mostly veiled, with an even edge and a soft shadow. The SVG draws the
    stage itself (base color, light, dot grid, grain and vignette) as a still picture. `toSvg`
    returns the stage's base color as `background` (`null` for graphite).
- **Live canvases**: `stage: false` leaves the stage and the glass panels out, so a page can paint
  them itself (the playground does, with WebGL, so the stage moves and the glass follows the
  pointer); the SVG then holds only what sits on the glass. `toSvg` returns every card's position
  as `boxes`. `idPrefix` (default `rz-`) prefixes every id, so several drawings can share a page.
- **Hooks for viewers**: a table is `g.rz-t[data-t]`, its header `g.rz-head`, a column row `g.rz-c[data-c]`, a connector
  `g.rz-r` with `data-a`/`data-ac` (primary key side) and `data-b`/`data-bc` (foreign key side). In a
  still glass drawing a table's shadow (`.rz-s`) carries the same `data-t`, and the dot grid is
  `.rz-grid`, so a viewer can fade a table or hide the grid with CSS alone.
- **Deterministic**: text is never measured. Widths follow fixed rules (monospace: 0.6em per
  cell; proportional: 0.57em per Latin letter, 1em per CJK character), so the same input yields the
  same SVG in a browser and on the command line.

## 6. Diagnostics

Every error and warning has a `line:column` position, and most have a hint. The parser skips the
line an error is on and keeps going, **so one run reports several errors**. When there are syntax
errors, semantic checks do not run (they would report bogus follow-up errors). When there is any
error, no model and no output are produced.

## 7. Migrating from v0.1

The parser recognizes v0.1 syntax and says how to write it in v0.2.

| v0.1 | v0.2 |
|---|---|
| `erd` on the first line | Delete it |
| `index(idx_name)` | `index as idx_name` |
| `unique name(a, b)` / `index name(a, b)` | `unique(a, b) as name` / `index(a, b) as name` |
| `} audit(a, b)` / `} audit` | `} audit envers(a, b)` / `} audit envers` |
| An outside reference written as a description | Declare an `external table` and use `~>` |

## 8. Importing SQL

`fromSql(sql)` (the playground's paste, `resin --from-sql`) writes SQL DDL as resin. It is part of the
language's definition in the same way as the drawing: these rules say what each SQL fact means in
resin.

### 8.1 Reading

- One reader takes every dialect: MySQL and MariaDB, PostgreSQL, SQLite, SQL Server and Oracle.
  Names are quoted with `"..."`, `` `...` `` or `[...]`; a `[` that cannot start a name (`text[]`)
  is punctuation. Strings take `''`, and also `\'` when the text uses backticks (MySQL dumps).
  Comments are `--`, `/* */` and `#` at the start of a line. MySQL's `/*!NNNNN ... */` is read as
  code.
- Statements end at `;`, at a line holding only `GO` or `/`, at the delimiter `DELIMITER` sets, and
  before a line that starts with `CREATE` or `ALTER` outside parentheses. psql meta-commands and the
  data of `COPY ... FROM stdin` are skipped.
- Each statement is read on its own. Read are `CREATE TABLE`, `DROP TABLE`, `ALTER TABLE` (`ADD`
  constraints and columns, `ALTER COLUMN ... SET` / `DROP NOT NULL`, `MODIFY`), `CREATE [UNIQUE]
  INDEX`, `COMMENT ON TABLE` / `COLUMN`, `CREATE TYPE ... AS ENUM`, `ALTER TYPE ... ADD VALUE` and
  SQL Server's `sp_addextendedproperty` for `MS_Description`. Every other statement is skipped.
- Tables are resolved in two passes: first `CREATE TABLE`, `DROP TABLE` and enum types, in order;
  then `ALTER TABLE`, `CREATE INDEX` and `COMMENT ON`, in order. References are resolved last.
- Table and column names match without regard to case or schema. The `CREATE TABLE` spelling is
  written. Two tables of one name in different schemas are written `` `schema.name` ``.
- When the tables come from two or more schemas, each schema's tables are written in a `group`
  named after the schema, in the order the schemas first appear; tables of no schema stay outside.
  One schema (all `public`, say) makes no group.

### 8.2 Mapping

| SQL | resin |
|---|---|
| `NOT NULL`, or a primary key column | No `?` |
| Any other column | `?` |
| `PRIMARY KEY` (column, table or `ALTER TABLE ADD`) | `pk` on each column |
| A unique constraint or unique index over one column | `uk` / `uk as name`. Left out on a column that is the whole primary key |
| The same over several columns | `unique(...)` / `unique(...) as name`. Left out when it is the primary key |
| An index over one column | `index` / `index as name`; a second index on the same column is left out |
| The same over several columns | `index(...)` / `index(...) as name` |
| A one-column foreign key to `t.c` | `-> t` when `c` is the primary key of `t`, `-> t.c` otherwise |
| A foreign key to a table the SQL does not create | `-> t`, and `external table t` with the columns referenced; a lone column is its `pk`. Without a column, the column is taken to be `id` |
| A foreign key to a table in `known` | `-> t` / `-> t.c`, with no external table |
| MySQL `enum('A', ...)` | Type `enum`, `enum(A, ...)` |
| A column whose type is a `CREATE TYPE ... AS ENUM` | That type, `enum(...)` |
| `CHECK (c IN (...))`, `CHECK (c = ANY (ARRAY[...]))`, `CHECK (c = v OR c = w ...)` | `enum(...)` on `c` |
| A column or table comment (`COMMENT`, `COMMENT=`, `COMMENT ON`, `MS_Description`) | The description, on one line |
| `revinfo`, and `<t>_aud` holding `rev` and `revtype` for a table `t` with a primary key | `audit envers` on `t` when `<t>_aud` holds every column `audit envers` would, `audit envers(...)` with the columns it holds otherwise; `revinfo` and `<t>_aud` are not written |
| `CREATE VIEW` of the name of a table created before it | The table is dropped (mysqldump's placeholder) |

- **Types** are lowercased and normalized to one name with number arguments: multi-word names
  (`character varying` → `varchar`, `double precision` → `double`, `timestamp with time zone` →
  `timestamptz`), `serial` types to their integer type, integer display widths and `unsigned`
  dropped, non-number arguments (`max`, `*`) drop the arguments, the schema of a type is dropped,
  arrays get PostgreSQL's `_` prefix (`text[]` → `_text`), and a column with no type is `any`.
- **Names** that are not identifiers, and **enum values** that are neither identifiers nor numbers,
  are written in backticks.
- **Inferred references** (`inferReferences`) are off by default. A column without a reference
  whose name ends in `_id` or `Id` points with `~>` at the table named by the words before it,
  singular or plural, possibly after up to three leading words, when that table's primary key is
  one column of the same type name. The output then starts with a comment saying so.

### 8.3 What is left out

- Not written: defaults, auto-increment and identity, checks other than value lists, `ON DELETE` /
  `ON UPDATE`, collations, storage and partition options, sequences, privileges and data.
- Views, materialized views, triggers, functions and procedures are not written; the first line
  counts them: `%% Skipped: 2 views, 1 trigger`.
- Composite foreign keys and expression indexes are not written. Each stays in its table as a
  comment, `%% Not converted: ...`. A partial unique index is written as a plain index with the
  comment `%% Partial unique index ...`, because it is unique among some rows only.
- Every comment of this kind, every skipped object and every statement that could not be read is
  also reported as a note with its line and column in the SQL.

## 9. Lint

`lint(doc)` checks a document that compiled without errors against rules of schema design. A finding
is a warning that carries the name of its rule; it never stops the output. The command line runs the
rules with `--lint`, and the playground runs them on every change.

An **index of a table** is any of: the primary key (its columns in document order), a `uk`, a
`unique(...)`, a column `index` and an `index(...)`. An index **starts with** a column when the
column is the first in its list.

| Rule | Reported when | Where | Message |
|---|---|---|---|
| `ref-index` | A column of a table (not external) holds a reference (`->` or `~>`) and no index of the table starts with it | The column name | ``reference column `c` has no index`` |
| `no-pk` | A table (not external) has no primary key | The table name | ``table `t` has no primary key`` |
| `unrelated` | The document has two or more tables, and no reference joins this one to another table. A reference of a table to itself does not count | The table name | ``table `t` has no references to or from other tables``; for an external table, ``external table `t` is not referenced`` |
| `type-drift` | Columns of one name appear in two or more tables with different type names (arguments are not compared). The type most of them have is taken as the norm, the first one on a tie, and every other column is reported. A column whose reference already gets the type mismatch warning is left out of the comparison | The type | ``column `c` is int here but bigint in `t1`, `t2` `` (at most three tables, then `and N more`) |
| `dup-index` | An `index` or `index(...)` whose column list is the start of another index's list. When the lists are equal, the later one is reported, unless the other is unique. Also a `uk` or `unique(...)` over exactly the primary key's columns | The `index`, `uk`, `unique` or `index(` keyword | ``the index on (`a`) is covered by `ix_ab` (`a`, `b`)``; ``unique on (`id`) repeats the primary key`` |

Every finding has a hint on how to fix it. In compiler format the rule follows the message in
brackets: ``schema.erd:28:3: warning: reference column `payer_user_id` has no index [ref-index]``.
