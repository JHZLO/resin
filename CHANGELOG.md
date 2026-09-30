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
- A command-line entry (`pnpm resin <file.erd> [--svg]`) and a web playground.
