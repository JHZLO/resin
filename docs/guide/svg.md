# SVG

The command line, and `toSvg` in code, draw the diagram with resin's own renderer. It lays out the tables with ELK's layered algorithm, with a port on every column row, so each connector runs from a foreign key row to the primary key row it points at.

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
  order_id  bigint  uk  -> orders
  memo      text?
}
```

## Cards

A card has the table's name and description in its header, then one row per column: a key label in a gutter (`PK`, `UK` or `FK`), the column's name and description, and its type at the right edge. A nullable column is marked `NULL` after its type. Tags `ENUM`, `ENC`, `IX` and `FK` sit before the type, and composite constraints are listed under the rows.

External tables have a dashed border and an `EXTERNAL` tag. Audit tables are folded into an `ENVERS` tag unless they are expanded.

## Services

A [service](services.md) is an area around its tables, with a faint tint, an even edge and its name and description at the top left. ELK lays a service out as a node that holds its cards, so the tables of a service stay together and connectors cross from one service to another. With a glass look, services take hues in the order they are declared (teal, violet, amber, rose, sky, lime, then again); `graphite` draws them in ink alone. The tint stops at the cards, so glass painted under the SVG is never tinted.

## Changes

A model from [`diff`](diff.md) carries what changed, and the drawing marks it: added in green, removed in red and faded, changed in amber, on the card's border and a tag in its header, at the left of a column's row, and on connectors.

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
| `columns` | `all`; `keys` for key and reference columns only; `none` for the table names alone, with the connectors between the headers | `all` |
| `audit` | `collapse`, or `expand` to draw `revinfo` and `*_aud` | `collapse` |
| `edges` | `angular` or `curved` | `angular` |
| `standalone` | Adds a style that picks the ink color from the reader's theme, for files embedded with `<img>` | `false` |
| `stage` | `false` leaves out the background and the glass, for a page that paints them itself | `true` |
| `idPrefix` | Prefixes every id, so several drawings can share a page | `rz-` |

## Hooks for viewers

A table is `g.rz-t[data-t]`, a service `g.rz-svc[data-svc]`, a table's header `g.rz-head`, a column row `g.rz-c[data-c]`, and a connector `g.rz-r`, with `data-a` and `data-ac` for its primary key side and `data-b` and `data-bc` for its foreign key side. A page can fade or highlight parts of the drawing with CSS alone.

## Deterministic

Text is never measured. Widths follow fixed rules, so the same input gives the same SVG in a browser and on the command line.

## Composite constraints

Composite references draw one connector per ordered column pair while retaining one semantic relation in the model. Their connectors carry `data-acs` and `data-bcs` JSON arrays for coordinated focus. Cards include the constraint in their footer, and Keys keeps every member column. Service-owned cards display the short table label and use the qualified identity in `data-t` and layout boxes.
