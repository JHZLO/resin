# Diagnostics

Every error and warning has a line and a column, and most have a hint on how to fix it.

```text
schema.erd:8:27: error: referenced table `customer` is not in this document
  |
8 |   customer_id  bigint  -> customer
  |                           ^^^^^^^^
  = hint: declare it with `external table` if it lives outside this document
```

## How resin reports

- The parser skips the line an error is on and keeps reading, so one run reports several errors.
- When there are syntax errors, the semantic checks do not run: on a broken tree they would report errors that are not real.
- When there is any error, there is no model and no output. Warnings never stop the output.

## Errors

| Message | What to do |
|---|---|
| ``referenced table `x` is not in this document`` | Declare the table, or declare it with `external table` if it lives elsewhere |
| ``table `t` has no column `c` `` | Check the column name in the reference, constraint or audit list |
| ``cannot pick a target column: the primary key of `t` is not a single column`` | Name the target column, as in `-> t.column` |
| ``primary key `c` cannot be nullable`` | Remove the `?` after the type |
| `columns of an external table cannot hold references` | Declare it as `table` to draw this relation |
| ``table `t` is declared twice``, ``column `c` appears twice in table `t` `` | Rename or remove one of them |
| ``name `n` is used twice in table `t` `` | Index and unique names must differ within a table |
| ``column `c` has no type`` | A column is written `name type`, as in `id bigint pk` |
| `duplicate ...` | A modifier appears twice on one column |
| ``unknown modifier `x` `` | A column accepts `pk`, `uk`, `enc`, `enum`, `index`, `->`, `~>` and a description |
| ``audit` cannot be used on an external table``, ``audit` needs a primary key`` | Audit only tables of your own that have a primary key |
| ``unknown audit method `x` `` | The only method is `envers` |
| `` `revinfo` clashes with a table that `audit` generates`` | Remove it and let `audit` generate it, or rename it |
| `names with non-ASCII letters must be wrapped in backticks` | Write the name in backticks |
| `unterminated string`, `unterminated backtick name` | Close it on the same line |

## Warnings

| Message | What it means |
|---|---|
| ``type mismatch: `c` is int but `t.id` is bigint`` | A reference joins columns of different types. Lengths are not compared |
| `` `unique(...)` over a single column`` | Use the column modifier `uk`, or `index` for `index(...)` |
| ``primary key `id` is always part of the audit table`` | Drop it from the `audit envers(...)` list |

## Lint

[Lint rules](lint.md) report schema design that compiles but is likely a mistake, such as a reference column without an index. They are warnings too, with the rule's name after the message, as in `[ref-index]`. The playground runs them on every change; on the command line `--lint` does.

## Old syntax

The parser recognizes the syntax of v0.1 and says how to write it now, as in ``index names go after `as` since v0.2``. See [Migrating from v0.1](migrating.md).
