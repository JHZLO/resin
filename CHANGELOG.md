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
- Mermaid `erDiagram` output, tested against Mermaid 11.16.
- SVG output laid out with ELK, with connectors from each foreign key row to its primary key row.
  A nullable column is marked `NULL` after its type, as in DDL.
- SVG looks: `graphite`, plain ink with no background (the default), and frosted glass in three
  themes, each dark or light: `aurora` (ribbons of light under stars), `silk` and `caustic`.
- A command-line entry (`pnpm resin <file.erd> [--svg [--look <look>]]`) and a web playground with a
  live glass canvas (WebGL): the background moves with the pointer's light, and a tap sends a ripple.
  Clicking a table name opens a side panel that lists its columns (key, type, NULL or NOT NULL,
  description, enum values), indexes and relations as tables; its left edge resizes it. Clicking a
  column opens a popover with its details. The editor shows problems and the cursor position in a
  status bar, and folds away for a wide diagram (Ctrl or Cmd + `\`). Downloads are plain SVG by
  default, or a still of the glass theme.
- Angular or curved connectors (`edges: "curved"`, `--curved`).
- A website: a landing page, docs for every construct of the language with a diagram for each
  example, and the playground, now at `/playground/`. Links to the old address still open it.
