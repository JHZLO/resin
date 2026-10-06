# References

A reference is written on the column that holds it. `->` is a foreign key the database enforces; `~>` is a reference only the application keeps. resin draws both from that column to the column they point at, and works out how many rows sit on each side.

## Foreign and logical

```erd example file=orders.erd "Solid for the foreign key, dashed for the logical reference into another service"
external table users "Accounts service" {
  id  bigint  pk
}

table orders "Customer orders" {
  id       bigint  pk
  user_id  bigint  ~> users  "Customer"
}

table order_items "Order lines" {
  id        bigint  pk
  order_id  bigint  -> orders.id
}
```

`order_items.order_id` has a `FOREIGN KEY` constraint in the database, so it uses `->` and is drawn solid. `orders.user_id` points into another service, where no constraint can exist, so it uses `~>` and is drawn dashed. A table owned by someone else is declared [external](external-tables.md): list only the columns you point at.

| Arrow | Meaning | Drawn as |
|---|---|---|
| `->` | Foreign key: the database declares the constraint | A solid line |
| `~>` | Logical reference: the application keeps it, the database does not | A dashed line |

## Which column

`-> orders.id` names the target column. Leave the column out and the reference points at the target's primary key, which must then be a single column. The target must be a table or an external table in the same document.

> [!TIP]
> If the column types differ, say `bigint` against `int`, resin warns you. Lengths such as `varchar(32)` are not compared, because foreign keys often mix them.

## One or many

```erd example file=payments.erd "order_id is unique, so each order has at most one payment: the child end reads 1"
table orders {
  id  bigint  pk
}

table payments "Payments" {
  id        bigint  pk
  order_id  bigint  uk  -> orders  "One payment per order"
}
```

A reference is one-to-many unless the referencing column is unique. When it has `uk`, or is its table's only primary key, each parent has at most one child, and the relation is one-to-one. The diagram marks the child end `N` or `1`.

## Must a parent exist?

```erd example file=checkout.erd "payer_id is nullable: a payment may have no payer, and its row says NULL"
table users {
  id  bigint  pk
}

table payments {
  id        bigint   pk
  payer_id  bigint?  ~> users  "Empty for guest checkout"
}
```

A NOT NULL referencing column means every row has exactly one parent. Make it nullable with `?` and the parent becomes optional: zero or one. The diagram shows `NULL` on that row.

## Composite references

```erd example file=composite.erd "A tenant and product id form one foreign key"
table products {
  tenant_id  bigint  pk
  id         bigint  pk
}

table order_items {
  id          bigint  pk
  tenant_id   bigint
  product_id  bigint
  foreign(tenant_id, product_id) -> products(tenant_id, id) as fk_product
  index(tenant_id, product_id)
}
```

The two lists are ordered: `tenant_id` references `tenant_id`, and `product_id` references `id`. This is one constraint and one model relation. Both lists need at least two distinct columns and the same number of columns. `~>` writes a composite logical reference. A target in another service uses `foreign(a, b) ~> service.target(x, y)`.

The diagram draws each column pair. Selecting any member highlights every pair in the constraint. The details panel lists the constraint as one reference. A composite relation is one-to-one when its complete source set is a primary or unique key. It is optional when any source column is nullable.
