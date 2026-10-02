# Playground

The [playground](https://jhzlo.github.io/resin/playground/) is an editor on the left and the diagram on the right. Every change recompiles. Problems show up in the editor and in a list under it, and the diagram keeps the last valid drawing until the source compiles again.

## Pasting SQL

Paste a `CREATE TABLE` script into the editor and it comes in as resin: keys, indexes, foreign keys, enum values and comments carry over. One undo brings back the SQL exactly as you pasted it. See [Importing SQL](sql.md) for what converts and what is left out.

## Reading a diagram

Click a table's name for a side panel that lists its columns, indexes and references as tables. Its left edge resizes it. Click a column, on the diagram or in the panel, for a small card with its details; its text can be selected and copied. A column that holds or receives a reference also highlights that reference.

The wheel zooms around the pointer, dragging pans, and a double click fits the drawing to the screen.

## View options

| Option | What it does |
|---|---|
| Keys only | Shows only key and reference columns, and folds the rest into `+N columns` |
| Audit tables | Draws `revinfo` and the `*_aud` tables instead of folding them into a tag |
| Angular, Curved | Right-angled connectors, or S-bends |
| Aurora, Silk, Caustic | The background behind the glass |
| Grid | The dot grid |

## Sharing and exporting

Copy link puts the whole document in the address, so the link opens exactly what you see. Copy SVG and the SVG menu export the drawing: plain by default, with no background, or the current background as a still image.

## Keyboard

| Keys | Action |
|---|---|
| Ctrl or Cmd + `\` | Hide or show the editor |
| Esc | Close the column card, then the side panel |
| Ctrl or Cmd + Z, right after pasting SQL | Undo the conversion, keeping the SQL as pasted |
| Arrow keys on the divider | Resize the editor |
