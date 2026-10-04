# Command line

From a clone of the repository, `pnpm resin` compiles one file; see [Quick start](quick-start.md) to set it up.

```text
usage: resin <file.erd> [options]
       resin diff <before.erd> <after.erd> [--markdown] [drawing options]
       resin <file.sql> --from-sql [--infer-refs]

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

  diff             draw <after.erd> with what changed since <before.erd>
                   marked: added, removed, changed. The drawing options apply
    --markdown     print the list of changes as Markdown instead
```

## Output

The result goes to standard output, and problems go to standard error in compiler format, so a redirect keeps them apart:

```bash
pnpm resin schema.erd > schema.svg
pnpm resin schema.erd --keys --curved > schema.keys.svg
pnpm resin schema.erd --model > schema.json
```

The SVG is ready to embed with `<img>`: with the default look it picks its ink color from the reader's light or dark theme.

## Lint

`--lint` checks the file against the [lint rules](lint.md) as well, prints nothing but the problems and exits with status 1 when there is an error or a finding, which makes it a CI step:

```bash
pnpm resin schema.erd --lint
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

## Exit status

| Status | When |
|---|---|
| `0` | The file compiled, possibly with warnings |
| `1` | There was at least one error; nothing was printed but the problems. With `--lint`: also a lint finding. With `--from-sql`: the file creates no table |
| `2` | The command was wrong: no file, or an unknown look |
