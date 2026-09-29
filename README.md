# Resin

A small language for ER diagrams. It borrows its shape from Mermaid's `erDiagram`, but records schema
facts (nullability, keys, physical vs. logical references, indexes, encryption, audit tables) as
syntax instead of comment-string conventions. It currently compiles to Mermaid `erDiagram`.

```erd
erd
  table ts_order {
    id          bigint    pk
    buyer_name  varchar?  enc  "Buyer name"
    status      varchar   enum(PENDING, PAID, CANCELED)  index(idx_status)
  } audit(status)

  table ts_order_item {
    id        bigint  pk
    order_id  bigint  -> ts_order.id
  }
```

- `varchar?` nullable, `pk` / `uk` keys, `enc` encrypted
- `->` physical foreign key, `~>` logical (app-level) reference; a `uk` reference is 1:1
- `audit(...)` generates Hibernate Envers `*_aud` and `revinfo` tables

The language reference is [docs/SPEC.md](docs/SPEC.md).

## Development

Requires Node 22.18+ (runs TypeScript directly) and pnpm.

```bash
pnpm install
pnpm check                      # typecheck + tests
pnpm resin examples/order.erd   # compile to Mermaid
```
