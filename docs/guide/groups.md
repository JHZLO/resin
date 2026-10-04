# Groups

A group puts tables that belong together under one name: the tables of a service, a domain, a part of a schema. The diagram draws it as an area around them.

```erd example file=orders.erd "Two services: the order service's tables, and the user table the accounts service owns"
group accounts "Accounts service" {
  external table users {
    id  bigint  pk
  }
}

group ordering "Order service" {
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

## Writing a group

`group name "description" { ... }` holds `table` and `external table` blocks, and nothing else. The description, in double quotes, is for people and may be left out. Tables written inside a group belong to it; tables outside every group belong to none.

An [external table](external-tables.md) in a group says which outside service owns it, so the diagram shows where the boundary between services runs.

## Rules

- Groups do not nest, and a table belongs to at most one group.
- Group names are unique within a document. A group may share its name with a table.
- Grouping changes nothing else: table names stay unique across the whole document, and references cross groups freely.
- A group with no tables is reported as a warning.
- When audit tables are drawn, `<table>_aud` sits in the group of its table, and `revinfo` in none.

## In the diagram

Each group is an area with a faint tint, an even edge and its name and description at the top left. The tables of a group are laid out together, and connectors run between groups as they do inside one. In the glass looks groups take hues in the order they are declared (teal, violet, amber, rose, sky, lime); the plain `graphite` look draws them in ink. The playground's side panel says which group a table is in.

When resin [imports SQL](sql.md) whose tables come from two or more schemas, it writes each schema's tables in a group named after the schema.
