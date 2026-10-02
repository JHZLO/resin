# Indexes

`index` on a column declares an index that starts at it, and `index as name` names it.

```erd example file=orders.erd
table orders {
  id          bigint    pk
  user_id     bigint    index as idx_orders_user
  status      varchar   index
  created_at  datetime
  index(status, created_at) as idx_orders_status_time
}
```

## Single and composite

`index` describes an index whose first column is this one. Leave out `as` when the name is not known. An index over several columns is a [table constraint](constraints.md), `index(a, b)`, optionally followed by `as name`. `index(a)` over a single column is reported as a warning, with a hint to use the column modifier instead.

## Names

Index and unique names are shown, not checked against a database. A name used twice in one table is an error, though, since it would be ambiguous.

## In the diagram

A column with an index carries an `IX` tag before its type, and composite indexes are listed at the foot of the card. The playground's side panel lists every index of a table, with its name and its columns.
