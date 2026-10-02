# Table constraints

Some facts span several columns. Write them as a line of their own inside the table block.

```erd example file=order_items.erd
table orders {
  id  bigint  pk
}

table order_items {
  id          bigint  pk
  order_id    bigint  -> orders
  product_id  bigint
  unique(order_id, product_id) as uk_order_product
  index(product_id, order_id)
}
```

| Constraint | Meaning |
|---|---|
| `unique(a, b)`, `unique(a, b) as name` | A composite UNIQUE |
| `index(a, b)`, `index(a, b) as name` | A composite index |

Every column in the list must exist in the table. For a single column, use the column modifiers `uk` and `index`; a constraint over one column is reported as a warning.

## A column called index

A constraint starts only when `(` follows the keyword directly. So `index int` is a column named `index`, while `index(a, b)` is a constraint:

```erd
table jobs {
  id     bigint  pk
  index  int     "Position in the queue"
}
```

Keywords in resin are never reserved; see [Names and comments](names.md).
