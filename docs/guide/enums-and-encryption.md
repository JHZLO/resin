# Enums and encryption

Two modifiers say what a column holds and how it is stored.

## Enums

`enum(...)` lists the values a column may hold. Values are names or numbers.

```erd example file=orders.erd
table orders {
  id        bigint   pk
  status    varchar  enum(PENDING, PAID, CANCELED)
  priority  int      enum(0, 1, 2)
}
```

Write only values the schema or its comments support: an enum in resin is a statement about the data. The values show in the playground's side panel, in the column card and in the Mermaid output, and the diagram tags the column `ENUM`.

## Encryption

`enc` says a column is stored encrypted.

```erd example file=members.erd
table members {
  id     bigint        pk
  name   varchar(100)  enc
  phone  varchar(20)?  enc  "Mobile number"
}
```

The diagram tags it `ENC`.
