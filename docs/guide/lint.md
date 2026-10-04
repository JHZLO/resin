# Lint

Lint rules point at schema design that compiles but is likely a mistake: a reference column with no index, a table with no primary key, a table nothing joins, a column name typed two ways, an index another one covers. A finding is a warning that carries its rule's name, and it never stops the drawing.

## Running it

The playground runs the rules on every change: the status bar counts the findings, pressing the count lists them, and each has a dotted underline in the editor (see [Playground](playground.md#lint)). On the command line, `--lint` checks a file and prints only the problems, so it fits a CI step:

```bash
pnpm resin schema.erd --lint
```

```text
schema.erd:8:3: warning: reference column `user_id` has no index [ref-index]
  |
8 |   user_id  bigint  -> users
  |   ^^^^^^^
  = hint: add `index` to the column, or start a composite index with it

schema.erd:9:21: warning: the index on (`status`) is covered by `ix_status_id` (`status`, `id`) [dup-index]
  |
9 |   status   varchar  index
  |                     ^^^^^
  = hint: remove it; the wider index serves lookups on (`status`) too
```

It exits with status 1 when there is an error or a finding, and 0 when the file is clean. In code, run `lint(result.doc)` on a document that compiled; see [Library](library.md).

The rules run only on a document without errors: they need its references resolved.

## ref-index

A column that holds a reference (`->` or `~>`) needs an index that starts with it. Joining a parent to its children, or deleting a parent, looks the children up by that column; without an index the database reads the whole table. PostgreSQL does not create these indexes for foreign keys by itself.

```erd
table customers {
  id  bigint  pk
}

table orders {
  id           bigint  pk
  customer_id  bigint  -> customers
}
```

``reference column `customer_id` has no index``. Add `index` to the column, or start a composite index with it. The column's `uk`, an `index(...)` or `unique(...)` that lists it first, and the primary key, when the column is its first column, all count.

## no-pk

A table of your own needs a primary key: without one, rows cannot be told apart, and tools that replicate or audit rows refuse the table. External tables are left out.

``table `audit_log` has no primary key``. Mark its key column `pk`.

## unrelated

In a document of several tables, a table that no reference joins to another one is often a reference that was never written, or a table that belongs in another document. A table that points only at itself, like a tree of categories, still counts as unrelated. An external table that nothing points at is reported too, since it is there only to receive references.

``table `settings` has no references to or from other tables``, ``external table `users` is not referenced``. Connect it with `->` or `~>` when it relates to another table.

## type-drift

Columns of one name usually hold one kind of value, so they should have one type. When `user_id` is `bigint` in most tables and `int` in one, the odd one is reported:

```erd
table orders {
  id       bigint  pk
  user_id  bigint
}

table carts {
  id       bigint  pk
  user_id  bigint
}

table reviews {
  id       bigint  pk
  user_id  int
}
```

``column `user_id` is int here but bigint in `orders`, `carts` ``. The type most of the columns have is taken as the norm. Type arguments are not compared, so `varchar(20)` and `varchar(40)` agree. A column whose reference already has a type mismatch warning is left out, so the same problem is not reported twice.

## dup-index

An index whose columns are the start of another index's columns serves no lookup the wider one does not, and every index slows down writes:

```erd
table orders {
  id          bigint    pk
  status      varchar   index
  created_at  datetime
  index(status, created_at) as ix_status_time
}
```

``the index on (`status`) is covered by `ix_status_time` (`status`, `created_at`)``. Remove the narrower one. Two indexes over the same columns are reported once, at the later one, and a `uk` or `unique(...)` over exactly the primary key's columns is reported as repeating it.

## The rules at a glance

| Rule | Finds |
|---|---|
| `ref-index` | A reference column that no index starts with |
| `no-pk` | A table without a primary key |
| `unrelated` | A table no reference joins to another table |
| `type-drift` | A column whose type differs from the other columns of its name |
| `dup-index` | An index another index covers, or a unique constraint that repeats the primary key |

## Composite references

A composite reference needs an index, unique key or primary key whose leading columns match the ordered source list. The `ref-index` warning points at the whole constraint. A composite relation also counts when checking whether a table is unrelated.
