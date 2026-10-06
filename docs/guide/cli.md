# Command line

From a clone of the repository, `pnpm resin` compiles one file; see [Quick start](quick-start.md) to set it up.

```text
usage: resin <file.erd> [options]
       resin diff <before.erd> <after.erd> [--markdown] [drawing options]
       resin fmt <file.erd>... [--check]
       resin <file.sql> --from-sql [--infer-refs]
       resin <file.erd> --to-sql <db> [--service <s>]

  (no option)      print the diagram as SVG (needs elkjs)
    --look <look>  graphite (default, no background), or a glass theme:
                   aurora-dark, aurora-light, silk-dark, silk-light,
                   caustic-dark, caustic-light
    --curved       curved connectors instead of right-angled ones
    --keys         show key and reference columns only
    --names        show table names only
    --expand-audit draw audit tables instead of folding them
  --model          print the resolved model as JSON
  --ast            print the syntax tree as JSON
  --lint           check the lint rules too; print only the problems, and
                   exit with 1 when there is an error or a lint finding
  --from-sql       read SQL DDL and print it as resin
    --infer-refs   also read <table>_id columns as logical references (~>)
  --to-sql <db>    print the schema as SQL DDL for mysql, postgres, sqlite,
                   sqlserver or oracle; notes go to stderr
    --service <s>  only the tables of service <s>, for its own database

  diff             draw <after.erd> with what changed since <before.erd>
                   marked: added, removed, changed. The drawing options apply
    --markdown     print the list of changes as Markdown instead

  fmt              rewrite each file in resin's one layout, and print the
                   names of the files it changed
    --check        change nothing: print the files that are not formatted,
                   and exit with 1 when there is one

  --help           print this help and exit
  --               treat the remaining arguments as file names
```

## Output

The result goes to standard output, and problems go to standard error in compiler format, so a redirect keeps them apart:

```bash
pnpm resin schema.erd > schema.svg
pnpm resin schema.erd --keys --curved > schema.keys.svg
pnpm resin schema.erd --model > schema.json
```

The SVG is ready to embed with `<img>`: with the default look it picks its ink color from the reader's light or dark theme.

An error leaves standard output empty, including with `--model` and `--ast`. `--help` prints the usage to standard output and exits successfully without a file. Use `--` before a file name that starts with `-`.

Unknown options, extra files and conflicting output modes are errors. Choose one of `--model`, `--ast`, `--lint`, `--from-sql` or `--to-sql`, or omit them for SVG. Drawing options require SVG output; `--keys` and `--names` cannot be combined. `--markdown` requires `diff`, `--check` requires `fmt`, `--service` requires `--to-sql`, and `--infer-refs` requires `--from-sql`.

## Lint

`--lint` checks the file against the [lint rules](lint.md) as well, prints nothing but the problems and exits with status 1 when there is an error or a finding, which makes it a CI step:

```bash
pnpm resin schema.erd --lint
```

## Format

`fmt` rewrites files in resin's one layout and prints the names of the files it changed. With `--check` it changes nothing, prints the files that are not formatted and exits with status 1 when there is one, for CI. A file with syntax errors is left as it is, and its errors are printed. See [Formatting](formatting.md).

```bash
pnpm resin fmt schema.erd
pnpm resin fmt --check schemas/*.erd
```

## Diff

`diff` compares two versions of a file and draws the newer one with the changes marked, or lists them with `--markdown`. See [Comparing versions](diff.md).

```bash
pnpm resin diff old.erd new.erd > diff.svg
```

## From SQL

`--from-sql` reads a SQL file and prints it as resin. What did not convert is listed on standard error, with its line in the SQL:

```bash
pnpm resin schema.sql --from-sql > schema.erd
```

For the PostgreSQL dump in the repository, `pnpm resin examples/sql/postgres.sql --from-sql` notes, among others:

```text
examples/sql/postgres.sql:60:1: note: table `users`: not converted: index users_lower_email on (lower((email)::text))
examples/sql/postgres.sql:68:5: note: table `order_items`: not converted: composite foreign key (shop_id, sku) -> shop_items (shop_id, sku)
```

[Importing SQL](sql.md) describes what converts.

## To SQL

`--to-sql <db>` prints the schema as SQL DDL for `mysql`, `postgres`, `sqlite`, `sqlserver` or `oracle`, with notes on standard error. `--service <s>` writes only one service's tables, for its own database. See [Generating SQL](generating-sql.md).

```bash
pnpm resin schema.erd --to-sql postgres > schema.sql
pnpm resin schema.erd --to-sql mysql --service ordering > ordering.sql
```

## Exit status

| Status | When |
|---|---|
| `0` | The file compiled, possibly with warnings, or help was requested |
| `1` | A file could not be read, an error occurred, or rendering failed; standard output is empty. With `--lint`: also a lint finding. With `--from-sql`: the file creates no table |
| `2` | Invalid arguments: missing or extra files, unknown options or looks, or conflicting modes |
