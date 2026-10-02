# Audit tables

`audit envers(...)` after a table's closing brace declares the audit tables Hibernate Envers keeps for it.

```erd example file=orders.erd "Folded by default: the audit shows as an ENVERS tag"
table orders {
  id          bigint    pk
  user_id     bigint
  status      varchar   enum(PENDING, PAID, CANCELED)
  created_at  datetime
  updated_at  datetime
} audit envers(user_id, status)
```

## What gets generated

- `orders_aud` holds the primary key, `rev`, `revtype` and the listed columns.
- `audit envers` with no list audits every column except the primary key, `created_at` and `updated_at`.
- As soon as one table is audited, a `revinfo` table is generated, with a relation to every `*_aud` table.

Declaring `revinfo` or `<table>_aud` yourself is an error, since resin generates them. `audit` needs a primary key, and external tables cannot be audited. `envers` is the only method so far.

## In the diagram

By default the audit tables are folded into an `ENVERS` tag on the audited table. Turn on Audit tables in the playground, or pass `--expand-audit` on the [command line](cli.md), to draw `revinfo` and the `*_aud` tables.
