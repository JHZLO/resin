# Playground

The [playground](https://jhzlo.github.io/resin/playground/) is an editor on the left and the diagram on the right. Every change recompiles. Problems show up in the editor and in a list under it, and the diagram keeps the last valid drawing until the source compiles again.

## Pasting SQL

Paste a `CREATE TABLE` script into the editor and it comes in as resin: keys, indexes, foreign keys, enum values and comments carry over. A line under the editor's header says so until you first use it. In an empty editor, or over an example you have not changed, the SQL takes the whole document; into a document of your own it goes where you paste it.

After a paste the same line says how many tables were converted. When the conversion left notes (the `%%` comments for what resin cannot write yet, and the count of skipped views and triggers), a button with their number steps through them. Undo, on the line or with Ctrl or Cmd + Z, brings back the SQL exactly as you pasted it. See [Importing SQL](sql.md) for what converts and what is left out.

## Lint

The playground runs the [lint rules](lint.md) on every change. The status bar under the editor counts the findings next to the compiler's own problems, as in `3 lint findings`; press the count to list them under the editor, and again to close the list. The playground remembers whether it was open. In the editor a finding has a dotted underline and a dot in the gutter; hover over it for the message, the hint and the rule. Errors and warnings of the compiler open the list by themselves, as before.

## Reading a diagram

Click a table's name for a side panel that lists its columns, indexes and references as tables. Its left edge resizes it. Click a column, on the diagram or in the panel, for a small card with its details; its text can be selected and copied. A column that holds or receives a reference also highlights that reference.

The wheel zooms around the pointer, dragging pans, and a double click fits the drawing to the screen.

## Finding a table

Find a table, in the diagram's header, or Ctrl or Cmd + K opens a search over the tables. It matches table names first, then descriptions, then column names; a table found by a column shows which one. Up and Down move through the results, Enter goes to the table and opens its side panel, and Shift Enter shows the table with only its related tables. Esc closes the search.

## Related tables only

Related only, in a table's side panel, draws just that table and the tables its references join it to, laid out again to fit. A pill at the top of the canvas names the table, says how many tables are with it and switches between 1 step (the tables it references and the ones referencing it) and 2 steps (their neighbors too). Show all, or Esc once the panel is closed, brings every table back.

Following a reference in the side panel to a table the view leaves out moves the view to that table, so you can walk a large schema one table at a time. The header counts what is shown, as in `7 of 13 tables`.

## View options

| Option | What it does |
|---|---|
| All, Keys, Names | Every column; only key and reference columns, folding the rest into `+N columns`; or the table names alone, with the connectors between them |
| Audit tables | Draws `revinfo` and the `*_aud` tables instead of folding them into a tag |
| Angular, Curved | Right-angled connectors, or S-bends |
| Aurora, Silk, Caustic | The background behind the glass |
| Grid | The dot grid |

## Sharing and exporting

Copy link puts the whole document in the address, with the view options and the related view, so the link opens exactly what you see. Copy SVG and the SVG menu export the drawing as it is shown, related view included: plain by default, with no background, or the current background as a still image.

## Keyboard

| Keys | Action |
|---|---|
| Ctrl or Cmd + `\` | Hide or show the editor |
| Ctrl or Cmd + K | Find a table |
| Up, Down, Enter, Shift Enter | In the search: move, go to the table, show it with its related tables only |
| Esc | Close the search, the column card, the side panel, then the related view |
| Ctrl or Cmd + Z, right after pasting SQL | Undo the conversion, keeping the SQL as pasted |
| Arrow keys on the divider | Resize the editor |
