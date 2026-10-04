# Changelog

All notable changes to resin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Before 1.0, a minor version may change
the grammar; the parser then points old syntax at its new form.

## [Unreleased]

The first public version of the language, grammar v0.2.

### Added

- The resin language: tables with `name type[?] modifiers` columns, `pk`, `uk`, `enc`, `enum(...)`,
  `index`, physical (`->`) and logical (`~>`) references, composite `unique(...)` and `index(...)`.
- `external table` for tables owned outside the document.
- `uk as name`, `index as name` and `unique(...) as name` for constraint names.
- Type arguments (`varchar(32)`, `decimal(12,2)`) and backtick names (`` `order-items` ``).
- `audit envers(...)`, which generates Hibernate Envers `*_aud` and `revinfo` tables.
- Diagnostics with line, column and hints; several errors per run.
- A resolved model shared by every output.
- SVG output laid out with ELK, with connectors from each foreign key row to its primary key row.
  A nullable column is marked `NULL` after its type, as in DDL.
- SVG looks: `graphite`, plain ink with no background (the default), and frosted glass in three
  themes, each dark or light: `aurora` (ribbons of light under stars), `silk` and `caustic`.
- A command-line entry (`pnpm resin <file.erd> [--look <look>]`) and a web playground with a
  live glass canvas (WebGL): the background moves with the pointer's light, and a tap sends a ripple.
  Clicking a table name opens a side panel that lists its columns (key, type, NULL or NOT NULL,
  description, enum values), indexes and relations as tables; its left edge resizes it. Clicking a
  column opens a popover with its details. The editor shows problems and the cursor position in a
  status bar, and folds away for a wide diagram (Ctrl or Cmd + `\`). Downloads are plain SVG by
  default, or a still of the glass theme.
- Angular or curved connectors (`edges: "curved"`, `--curved`).
- Groups: `group name "description" { tables }` puts tables in a named group, a service or a
  domain, drawn as a tinted area with its name around them; hues follow the order of declaration,
  and graphite draws them in ink. SQL import writes the tables of each schema in a group when there
  are several schemas. The side panel says which group a table is in.
- Exploring a large schema in the playground: All, Keys and Names (table names only, also
  `columns: "none"` and `--names`), Find a table (Ctrl or Cmd + K, over names, descriptions and
  columns), and Related only, which draws a table with its neighbors one or two steps away
  (`neighbors(model, table, steps)`). Links carry the view.
- Lint rules for schema design: a reference column without an index (`ref-index`), a table without a
  primary key (`no-pk`), a table no reference joins (`unrelated`), a column name typed two ways
  (`type-drift`) and an index another one covers (`dup-index`). `lint(doc)`, `resin --lint` (exits
  with 1 on a finding, for CI) and the playground, which runs them on every change.
- SQL import: `fromSql`, `resin <file.sql> --from-sql` and pasting into the playground write SQL DDL
  as resin. In the playground a line under the editor's header says that pasting converts, and then
  what the paste became, with its notes and Undo. One reader takes MySQL, PostgreSQL, SQLite, SQL Server and Oracle, dumps included; keys,
  indexes, foreign keys, enum values, comments and Hibernate Envers tables carry over, and what
  resin cannot write stays as a comment. `--infer-refs` reads `<table>_id` columns as logical
  references.
- A website: a landing page, docs for every construct of the language with a diagram for each
  example, and the playground, now at `/playground/`. Links to the old address still open it.
