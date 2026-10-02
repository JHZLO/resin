# Columns and types

A column is written as in SQL DDL: its name first, then its type, then what is true about it, in any order.

```erd example file=products.erd
table products "Catalog" {
  id      bigint         pk
  sku     varchar(32)    uk as uk_products_sku
  name    varchar(200)   "Shown to customers"
  price   decimal(12,2)
  status  varchar        enum(ACTIVE, HIDDEN)  index
  note    text?
}
```

## Types

The type is the physical type name, with its arguments when it has them: `bigint`, `varchar(32)`, `decimal(12,2)`. resin keeps it as written and does not check it against a database, and the arguments may be left out.

A `?` right after the type makes the column nullable; see [Nullability](nullability.md).

## Modifiers

| Modifier | Meaning |
|---|---|
| `pk` | Primary key; see [Keys](keys.md) |
| `uk`, `uk as name` | Unique |
| `index`, `index as name` | An index that starts at this column; see [Indexes](indexes.md) |
| `enum(A, B)` | The values the column may hold; see [Enums and encryption](enums-and-encryption.md) |
| `enc` | Stored encrypted |
| `-> table.column` | Foreign key; see [References](references.md) |
| `~> table.column` | Logical reference |
| `"..."` | A description for people |

Writing the same modifier twice on one column is an error.

## Descriptions carry no facts

A description is for people. Anything a modifier can say goes in a modifier: write `index`, not `"indexed"`, and `~> users`, not `"refers to users"`. Facts written as syntax are checked and drawn; facts written in a description are not.
