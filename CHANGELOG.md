# Changelog

All notable changes to resin are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Before 1.0, a minor version may change
the grammar; the parser then points old syntax at its new form.

## [Unreleased]

The first public version of the language, grammar v0.2.

### Performance

- Index table and column resolution, and run source analysis in a background worker.
- Preserve diagrams for comment-only edits and live background changes, with bounded caches for recent views.
- Save changed documents and recovery records asynchronously with transactional conflict detection.
- Index relation focus and use high-degree layout handling for heavily referenced tables.
- Cover full-column load, view reuse, storage migration, rollback, and animation-enabled navigation.

### Fixed

- Keep related-table controls clear of view options and long table names on narrow canvases.
- Preserve qualified SQL targets and quoted names; report ambiguous or unsupported imports.
- Include reference cardinality and optionality changes in schema comparisons.
- Restore shared view options and empty comparison bases, validate saved state, and export the current source.
- Keep table panels open on repeated clicks, reveal folded columns, and restore focus after search.
- Fit large diagrams, handle interrupted touch gestures, and restore the glass canvas after context loss.
- Handle CLI usage errors and make PR comparisons safe to rerun, including renamed files and restricted tokens.
- Compare pull requests from their common ancestor to exclude unrelated base-branch changes.

### Quality checks

- Browser regression tests for Chromium, Firefox and WebKit, plus 10, 100 and 500-table load cases.
- CI checks on Node 22.18 and 24. Browser workflows and source checks must pass before Pages deployment.

### Added

- Named local documents, `.erd` and `.sql` files, recovery snapshots, and visible storage failure handling.
- SQL import review with original source, complete notes, service assignment and updates that retain annotations.
- Logical relation suggestions and editing, direction filters, relationship paths, service filters and saved views.
- File comparison with changed tables and neighbors, reading links, and PNG export.
- Cancellable layout in a real Web Worker, retry handling and layout reuse for cosmetic changes.
- Service-scoped table identities and ordered composite foreign-key constraints with coordinated column focus.

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
- Comparing versions: `resin diff <before.erd> <after.erd>` draws the newer version with added,
  removed and changed tables, columns and connectors marked, or lists them with `--markdown`
  (`diff`, `diffMarkdown`). A GitHub Action (`uses: JHZLO/resin@main`) keeps a comment on pull
  requests that change `.erd` files, with the list, the drawing and a link that opens both versions
  in the playground, which then compares them.
- Services: `service name "description" { tables }` says which tables a service owns, drawn as a
  tinted area with its name around them; hues follow the order of declaration, and graphite draws
  them in ink. A `->` from one service into another is a warning, as a FOREIGN KEY cannot tie two
  services' databases together; write `~>`. SQL import writes the tables of each schema in a service
  when there are several schemas. The side panel says which service a table is in. (For a day this
  was `group`; the parser points `group` at `service`.)
- Exploring a large schema in the playground: All, Keys and Names (table names only, also
  `columns: "none"` and `--names`), Find a table (Ctrl or Cmd + K, over names, descriptions and
  columns), and Related only, which draws a table with its neighbors one or two steps away
  (`neighbors(model, table, steps)`). Links carry the view.
- Formatting: `format(source)`, `resin fmt <file.erd>...` and the playground's Format (Shift + Alt +
  F) write a document in resin's one layout: one statement per line, two spaces per block, columns
  lined up within each table, comments kept. Only whitespace changes, and the result is checked to
  parse to the same document. `resin fmt --check` exits with 1 on a file that is not formatted.
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
