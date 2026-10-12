# Embedding the viewer

`resin/viewer` is the playground's diagram, for a page of your own: the canvas that pans, zooms and focuses, with the live glass under the cards, and the panels that describe a table, a service or a column. A page that embeds it shows a schema the way the playground does. It keeps its own controls and layout; the viewer tells it what was pressed.

It needs a browser. The language (`resin`) does not, and a page that only compiles or draws to a file never loads the viewer.

```ts
import ELK from "elkjs/lib/elk.bundled.js";
import { compile, toSvg } from "resin";
import { Canvas, tableDetails } from "resin/viewer";
import "resin/viewer.css";

const { model } = compile(source);
const panel = document.querySelector<HTMLElement>("#panel")!; // marked class="rz-details"

const canvas = new Canvas(document.querySelector<HTMLElement>("#diagram")!, {
  onTap(hit) {
    if (!model) return;
    if (hit.table && hit.header) {
      panel.replaceChildren(tableDetails(model, hit.table, (name) => canvas.reveal(name), () => {}, () => {}) ?? "");
      canvas.focusTable(hit.table);
    } else if (hit.table) canvas.focus?.table(hit.table);
    else canvas.focus?.clear();
  },
});
canvas.setLook("aurora", matchMedia("(prefers-color-scheme: dark)").matches);
canvas.setGrid(true);

if (model) canvas.show(await toSvg(model, new ELK(), { ...canvas.drawOptions(), columns: "all" }), true);
```

The element given to `Canvas` is the page's to size; the canvas fills it. Lay out a large schema in a Web Worker so the page stays responsive: `elkjs/lib/elk-api.js` takes a `workerUrl`, and anything with a `layout(graph)` method that returns a promise can be passed to `toSvg`.

## Canvas

| Member | What it does |
|---|---|
| `new Canvas(viewport, options)` | Takes the element over (it gets the class `rz-viewer`) and puts the drawing in its `.rz-content` child, made when there is none. Options: `onTap(hit, x, y)` for a press that did not move, `onView(animate)` after every pan or zoom, and `live: false` to leave WebGL out |
| `setLook(stage, dark)` | The background: `aurora`, `silk` or `caustic` (`CANVAS_STAGES`), dark or light. Draw again after changing it |
| `drawOptions()` | The `look` and `stage` to pass to `toSvg`. Over the live glass the SVG carries only what sits on it; without WebGL2, or with `live: false`, it is the still look |
| `look()` | The look as a still drawing has it, for exporting what the canvas shows |
| `show(drawing, fit)` | Puts a `toSvg` result on the canvas, or a drawing it returned before, and fits it when `fit` is true. Returns the drawing as shown, which can be shown again later without drawing it anew |
| `focus` | `table(name)`, `row(table, column)` and `clear()`: keep a table or a relation and fade the rest |
| `focusTable(name)`, `focusService(name)` | Focus a table, or its row where its service is folded; focus a service where it is one card |
| `reveal(name, covered, onlyIfCovered, animate)` | Brings a table to the middle of what is visible. `covered` is the width of a panel over the right edge |
| `revealElement(el, covered, animate)` | The same for any part of the drawing, unless it is already in plain view |
| `card(name)`, `row(table, column)`, `foldedRow(table)`, `serviceElement(name)` | Where things are drawn |
| `view` | The pan and zoom: `fit()`, `zoomBy(factor)`, `actualSize()`, `centerOn(x, y, covered)` and `scale` |
| `setGrid(on)`, `refresh(instant)`, `pause(paused)`, `destroy()` | The dot grid; drawing the glass again after the focus changed outside a press; stopping while out of sight; letting go of the element, its listeners and the GPU context |

A press reports `hit`: `table` (the card pressed, a folded service's card being `serviceCardId(service)`), `column` (the row pressed), `rowTable` (in a folded service's card, the table of the row), `service` (a folded service's card, or the label of a service's area) and `header` (the press was on a card's header or on an area's label). What it does is up to the page; the playground opens the table panel from a header, the column popover from a row, and the service panel from a service.

## Details

`tableDetails(model, table, open, pick, openService)`, `serviceDetails(model, service, open, pick, openService)` and `columnDetails(model, table, column, open)` return the playground's panels as elements: a table's columns (key, name, type, `NULL` or `NOT NULL`, description), indexes and references; a service's tables and what it depends on and is used by; one column's facts. They return `null` for a name the model does not have. `open`, `pick` and `openService` are called when a table name, a column or a service name in them is followed. Put them inside an element with the class `rz-details`.

## Styles

`resin/viewer.css` styles the canvas and the details. It reads these custom properties, with light defaults; set them on `:root` or any ancestor, dark values included, to match the page:

| Property | Used for |
|---|---|
| `--rz-ink`, `--rz-muted`, `--rz-faint` | Text, from strongest to faintest |
| `--rz-rule`, `--rz-panel`, `--rz-code` | Rules between rows, the panel's background, chips |
| `--rz-accent`, `--rz-accent-soft`, `--rz-active-line` | Links and the picked row; rows under the pointer |
| `--rz-k-pk`, `--rz-k-uk`, `--rz-k-fk`, `--rz-warn` | Key labels, `NULL`, a warning in the service panel |
| `--rz-stage` | Under the drawing before the first frame of the live background |
| `--rz-font-body`, `--rz-font-mono` | The two typefaces |
