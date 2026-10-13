// Choosing the parts of a row the cards show: one row of a card as a sample, in the card's own type,
// colors and order, with the name of each part above it. Pressing a part leaves it out of the cards or
// brings it back; a part left out fades in the sample. The column's name always stays, so it is not a
// button. The page keeps which parts are hidden and builds this again when they change.

import { CARD_PARTS, type CardPart } from "../src/index.ts";

interface Sample {
  caption: string;
  cls: string;
  text: string;
}
const NAME: Sample = { caption: "Column", cls: "p-name", text: "customer_id" };
const SAMPLE: Record<CardPart, Sample & { what: string }> = {
  keys: { caption: "Key", cls: "p-key", text: "FK", what: "the key labels" },
  tags: { caption: "Tags", cls: "p-tag", text: "IX", what: "the tags" },
  descriptions: { caption: "Description", cls: "p-desc", text: "Customer", what: "the descriptions" },
  types: { caption: "Type", cls: "p-type", text: "bigint", what: "the types" },
  nulls: { caption: "Null", cls: "p-null", text: "NULL", what: "NULL" },
};

function span(cls: string, text: string): HTMLSpanElement {
  const el = document.createElement("span");
  el.className = cls;
  el.textContent = text;
  return el;
}

function cell(tag: "span" | "button", s: Sample): HTMLElement {
  const el = document.createElement(tag);
  el.className = "p-part";
  el.append(span("p-cap", s.caption), span(`p-val ${s.cls}`, s.text));
  return el;
}

/** The sample row. `toggle` is called with the part pressed; the page decides what follows */
export function cardParts(hidden: ReadonlySet<CardPart>, toggle: (part: CardPart) => void): HTMLElement {
  const row = document.createElement("div");
  row.className = "rz-parts";
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "Parts of a row");
  const button = (part: CardPart): HTMLElement => {
    const b = cell("button", SAMPLE[part]) as HTMLButtonElement;
    b.type = "button";
    b.dataset.part = part;
    b.setAttribute("aria-pressed", String(!hidden.has(part)));
    b.title = `${hidden.has(part) ? "Show" : "Leave out"} ${SAMPLE[part].what}`;
    b.addEventListener("click", () => toggle(part));
    return b;
  };
  // The card's order: the key label, the name, then the rest
  row.append(button("keys"), cell("span", NAME), ...CARD_PARTS.filter((p) => p !== "keys").map(button));
  return row;
}
