# Services

resin is written for schemas split across services. A service owns its tables and keeps them in a database of its own, so a reference from one service into another cannot be a foreign key. `service` says which tables each service owns, the diagram draws it as an area around them, and resin warns when a `->` crosses from one service into another.

```erd example file=orders.erd "Two services: the order service's tables, and the user table the accounts service owns"
service accounts "Accounts service" {
  external table users {
    id  bigint  pk
  }
}

service ordering "Order service" {
  table orders {
    id       bigint  pk
    user_id  bigint  ~> users  index
  }

  table order_items {
    id        bigint  pk
    order_id  bigint  -> orders  index
  }
}

table shipments {
  id        bigint  pk
  order_id  bigint  ~> orders  index
}
```

## Writing a service

`service name "description" { ... }` holds `table` and `external table` blocks, and nothing else. The description, in double quotes, is for people and may be left out. Tables written inside a service belong to it; tables outside every service belong to none, as in a document about a single service.

Write the tables of each service the document describes in that service's block. An [external table](external-tables.md) is a table of a service the document does not describe: put it in a block named after that service, and the diagram shows where the boundary runs.

## References between services

Inside a service, a reference is whatever the database has: `->` for a foreign key, `~>` for a reference the application keeps. Between services there is no database constraint to write, so a reference is `~>`. A `->` from a table of one service to a table of another is reported as a warning. In `orders.erd`:

```erd
service accounts {
  table users {
    id  bigint  pk
  }
}

service ordering {
  table orders {
    id       bigint  pk
    user_id  bigint  -> users  index
  }
}
```

```text
orders.erd:10:22: warning: foreign key `orders.user_id` crosses from service `ordering` into `accounts`
   |
10 |     user_id  bigint  -> users  index
   |                      ^^
   = hint: a FOREIGN KEY ties the data of two services together; write `~>` for a logical reference
```

A reference to or from a table outside every service is not checked.

## Rules

- Services do not nest, and a table belongs to at most one service.
- Service names are unique within a document. A service may share its name with a table.
- Table names are unique within their service. Unscoped tables have their own namespace.
- An unqualified reference first looks in its own service, then accepts a unique matching table elsewhere. If more than one table matches, use `service.table.column`.
- A service with no tables is reported as a warning.
- When audit tables are drawn, `<table>_aud` sits in the service of its table, and `revinfo` in none.

## In the diagram

Each service is an area with a faint tint, an even edge and its name and description at the top left. The tables of a service are laid out together, and connectors run between services as they do inside one. In the glass looks services take hues in the order they are declared (teal, violet, amber, rose, sky, lime); the plain `graphite` look draws them in ink. The playground's side panel says which service a table is in.

When resin [imports SQL](sql.md) whose tables come from two or more schemas, it writes each schema's tables in a service named after the schema.

## Same table name in different services

```erd example file=service-names.erd "Each service owns its users table"
service accounts {
  table users { id bigint pk }
}
service billing {
  table users { id bigint pk }
  table invoices {
    id bigint pk
    owner_id bigint -> users
    account_id bigint ~> accounts.users.id
  }
}
```

`owner_id` resolves to `billing.users`. `account_id` explicitly selects `accounts.users`. Model and diagram data identifiers use qualified names; the card title remains `users`. A quoted literal name such as `a.b` remains distinct from table `b` in service `a`.
