# External tables

An external table lives outside the document: in another service, or another database. Declare it so that references to it are checked and drawn like any other.

```erd example file=orders.erd
external table users "Accounts service" {
  id  bigint  pk
}

table orders {
  id       bigint  pk
  user_id  bigint  ~> users
}
```

## What to list

List only the columns you point at, usually the primary key. An external table receives references and is checked like any other table, with two limits:

- its columns cannot hold references (`->` or `~>`);
- it cannot have `audit`.

A reference into another service usually has no database constraint behind it, so it is written `~>`, a [logical reference](references.md). Put the external table in a [service](services.md) block named after that service, and the diagram shows where the service boundary is.

## In the diagram

External tables have a dashed border and an `EXTERNAL` tag.
