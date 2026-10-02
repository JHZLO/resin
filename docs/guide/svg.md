# SVG

`--svg` on the command line, and `toSvg` in code, draw the diagram with resin's own renderer. It lays out the tables with ELK's layered algorithm, with a port on every column row, so each connector runs from a foreign key row to the primary key row it points at.

```erd example file=shop.erd
external table users "Accounts service" {
  id  bigint  pk
}

table orders "Customer orders" {
  id       bigint   pk
  user_id  bigint   ~> users
  status   varchar  enum(PENDING, PAID)  index
}

table payments {
  id        bigint  pk
  order_id  bigint  uk -> orders
  memo      text?
}
```

## Cards

A card has the table's name and description in its header, then one row per column: a key label in a gutter (`PK`, `UK` or `FK`), the column's name and description, and its type at the right edge. A nullable column is marked `NULL` after its type. Tags `ENUM`, `ENC`, `IX` and `FK` sit before the type, and composite constraints are listed under the rows.

External tables have a dashed border and an `EXTERNAL` tag. Audit tables are folded into an `ENVERS` tag unless they are expanded.

## Connectors

Solid for foreign keys, dashed for logical references. A chevron marks the primary key end, as in `->`; a square port and `N` or `1` mark the foreign key end. Connectors are right-angled by default, or S-bends with `edges: "curved"`, which keep the routed path wherever an S-bend would cross another card.

## Looks

| Look | Background |
|---|---|
| `graphite` | None, the default. Ink is `currentColor`, so the drawing reads on any page |
| `aurora-dark`, `aurora-light` | Ribbons of light under a sky of stars |
| `silk-dark`, `silk-light` | Folds of color |
| `caustic-dark`, `caustic-light` | Light through water |

With a glass look the cards are frosted glass over the background, which the SVG draws as a still picture.

## Options

| Option | Values | Default |
|---|---|---|
| `look` | One of the looks above | `graphite` |
| `columns` | `all`, or `keys` for key and reference columns only | `all` |
| `audit` | `collapse`, or `expand` to draw `revinfo` and `*_aud` | `collapse` |
| `edges` | `angular` or `curved` | `angular` |
| `standalone` | Adds a style that picks the ink color from the reader's theme, for files embedded with `<img>` | `false` |
| `stage` | `false` leaves out the background and the glass, for a page that paints them itself | `true` |
| `idPrefix` | Prefixes every id, so several drawings can share a page | `rz-` |

## Hooks for viewers

A table is `g.rz-t[data-t]`, its header `g.rz-head`, a column row `g.rz-c[data-c]`, and a connector `g.rz-r`, with `data-a` and `data-ac` for its primary key side and `data-b` and `data-bc` for its foreign key side. A page can fade or highlight parts of the drawing with CSS alone.

## Deterministic

Text is never measured. Widths follow fixed rules, so the same input gives the same SVG in a browser and on the command line.
