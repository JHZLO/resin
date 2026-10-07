import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ELK from "elkjs";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";
import { toSvg } from "./svg.ts";

const EXAMPLES = join(import.meta.dirname, "../examples");
const elk = new ELK();

const modelOf = (src: string) => {
  const r = compile(src);
  expect(r.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return r.model!;
};
const count = (svg: string, needle: string) => svg.split(needle).length - 1;
const widthOf = (svg: string) => Number(/viewBox="0 0 (\d+)/.exec(svg)![1]);

const ORDER = readFileSync(join(EXAMPLES, "order.erd"), "utf8");

describe("toSvg", () => {
  it("draws a card per table and a connector per relation, folding audit tables by default", async () => {
    const { svg, width, height } = await toSvg(modelOf(ORDER), elk);
    expect(count(svg, 'class="rz-t"')).toBe(4);
    expect(count(svg, 'class="rz-r"')).toBe(4);
    expect(count(svg, ">ENVERS</text>")).toBe(2);
    expect(count(svg, ">EXTERNAL</text>")).toBe(1);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });

  it("marks nullable columns NULL after the type, and keeps the types of a card aligned", async () => {
    const src = "table t {\n id bigint pk\n note varchar?\n}\ntable u {\n id bigint pk\n}";
    const { svg } = await toSvg(modelOf(src), elk);
    expect(count(svg, ">NULL</text>")).toBe(1);
    expect(svg).not.toContain(">?<");
    // In t, both types end where the NULL column starts; u has no nullable column and keeps none
    const [t, u] = svg.split('class="rz-t"').slice(1);
    const typeEnds = (card: string) => [...card.matchAll(/<text x="([\d.]+)" y="[\d.]+" text-anchor="end" font-family="[^"]+" font-size="11"/g)].map((m) => Number(m[1]));
    const [idEnd, noteEnd] = typeEnds(t);
    expect(idEnd).toBe(noteEnd);
    expect(typeEnds(u)[0]).toBeGreaterThan(0);
    expect(count(u, ">NULL</text>")).toBe(0);
    // The row's tooltip says it in words either way
    expect(svg).toContain("<title>note varchar NULL</title>");
    expect(svg).toContain("<title>id bigint NOT NULL</title>");
  });

  it("draws revinfo and *_aud when audit tables are expanded", async () => {
    const { svg } = await toSvg(modelOf(ORDER), elk, { audit: "expand" });
    expect(count(svg, 'class="rz-t"')).toBe(7);
    expect(count(svg, 'class="rz-r"')).toBe(6);
    expect(svg).toContain('data-t="payments_aud"');
  });

  it("collapses non-key columns into +N when showing keys only", async () => {
    const { svg } = await toSvg(modelOf(ORDER), elk, { columns: "keys" });
    expect(svg).toContain(">+4 columns</text>");
    expect(svg).not.toContain('data-c="buyer_name"');
  });

  it("dashes logical references and labels one-to-one 1 and one-to-many N", async () => {
    const { svg } = await toSvg(modelOf("table a {\n id bigint pk\n}\ntable b {\n id bigint pk\n a_id bigint uk ~> a\n c_id bigint -> a\n}"), elk);
    const rels = svg.split('<g class="rz-r"').slice(1);
    expect(rels.map((r) => [r.includes("stroke-dasharray"), />(1|N)<\/text>/.exec(r)?.[1]])).toEqual([
      [true, "1"],
      [false, "N"],
    ]);
  });

  it("paints no background: ink is currentColor, and only standalone output picks colors", async () => {
    const inline = await toSvg(modelOf(ORDER), elk);
    expect(inline.svg).not.toContain("<style>");
    expect(inline.svg).not.toMatch(/fill="#/);
    const file = await toSvg(modelOf(ORDER), elk, { standalone: true });
    expect(file.svg).toContain("prefers-color-scheme:dark");
  });

  const GLASS = ["aurora-dark", "aurora-light", "silk-dark", "silk-light", "caustic-dark", "caustic-light"] as const;

  it("draws every glass theme over its own stage, frosted under the cards", async () => {
    for (const look of GLASS) {
      const r = await toSvg(modelOf(ORDER), elk, { look });
      expect(r.background).toMatch(/^#/);
      expect(r.svg).toContain('id="rz-backdrop"');
      expect(r.svg).toContain('filter="url(#rz-frost)"');
      expect(r.svg).toContain('mask="url(#rz-cards)"');
    }
    expect((await toSvg(modelOf(ORDER), elk)).background).toBeNull();
  });

  it("puts stars only in the aurora sky", async () => {
    expect((await toSvg(modelOf(ORDER), elk, { look: "aurora-dark" })).svg).toContain("<circle");
    expect((await toSvg(modelOf(ORDER), elk, { look: "silk-dark" })).svg).not.toContain("<circle");
  });

  it("prefixes every id so several drawings can share a page", async () => {
    const { svg } = await toSvg(modelOf(ORDER), elk, { look: "aurora-dark", idPrefix: "a1-" });
    const ids = [...svg.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    const refs = [...svg.matchAll(/url\(#([^)]+)\)|href="#([^"]+)"/g)].map((m) => m[1] ?? m[2]);
    expect(ids.every((i) => i.startsWith("a1-"))).toBe(true);
    expect(refs.every((r) => ids.includes(r))).toBe(true);
  });

  it("leaves the stage and the panels to a live canvas, and says where every card is", async () => {
    const { svg, boxes, background } = await toSvg(modelOf(ORDER), elk, { look: "aurora-dark", stage: false });
    expect(svg).not.toContain("rz-stage");
    expect(svg).not.toContain("frost");
    expect(svg).not.toContain('class="rz-s"');
    expect(count(svg, 'class="rz-t"')).toBe(4);
    expect(background).toBe("#05060C");
    expect(boxes.map((b) => b.table)).toEqual(["accounts.users", "orders", "order_items", "payments"]);
    expect(boxes.every((b) => b.w >= 200 && b.h > 0)).toBe(true);
  });

  it("makes every table header one clickable group", async () => {
    const { svg } = await toSvg(modelOf(ORDER), elk);
    expect(count(svg, 'class="rz-head"')).toBe(4);
  });

  it("curves connectors into S-bends, and follows the route around a card that would be in the way", async () => {
    const angular = await toSvg(modelOf(ORDER), elk);
    const curved = await toSvg(modelOf(ORDER), elk, { edges: "curved" });
    const lines = (svg: string) => svg.split('<g class="rz-r"').slice(1).map((r) => /<path d="([^"]+)"/.exec(r)![1]);
    expect(lines(angular.svg).some((d) => d.includes(" C"))).toBe(false);
    // users.id → payments.payer_user_id would cut through orders, so it keeps the route with wide bends
    expect(lines(curved.svg).map((d) => (d.includes(" C") ? "bend" : "route"))).toEqual(["bend", "bend", "bend", "route"]);
    expect(curved.width).toBe(angular.width);
  });

  it("measures Hangul as double width", async () => {
    const latin = await toSvg(modelOf('table t "abcdefghijklmnopqrstuvwxyz abcdefghij" {\n id bigint pk\n}'), elk);
    const hangul = await toSvg(modelOf('table t "주문 주문 주문 주문 주문 주문 주문 주문 주문 주문" {\n id bigint pk\n}'), elk);
    expect(widthOf(hangul.svg)).toBeGreaterThan(widthOf(latin.svg));
  });

  it("draws self references", async () => {
    const { svg } = await toSvg(modelOf("table c {\n id bigint pk\n parent_id bigint? -> c\n}"), elk);
    expect(count(svg, 'class="rz-r"')).toBe(1);
  });

  it("is deterministic, stars included", async () => {
    for (const look of ["graphite", "aurora-dark"] as const) {
      const a = await toSvg(modelOf(ORDER), elk, { look });
      const b = await toSvg(modelOf(ORDER), new ELK(), { look });
      expect(a.svg).toBe(b.svg);
    }
  });
});

// Golden files: examples/<name>.erd → examples/<name>.svg (graphite, standalone), plus the order example
// in aurora, dark and light, which the README shows. Changing the drawing breaks these; open the SVG, check
// it by eye and update with `pnpm test -u` only when the change is intended.
describe("table names only", () => {
  it("draws headers alone, with every connector between them", async () => {
    const { svg, boxes } = await toSvg(modelOf(ORDER), elk, { columns: "none" });
    expect(count(svg, 'class="rz-t"')).toBe(4);
    expect(count(svg, 'class="rz-c"')).toBe(0);
    expect(count(svg, 'class="rz-r"')).toBe(4);
    expect(boxes.every((b) => b.h === 44)).toBe(true);
    // Nothing under the header: no column count, no constraints
    expect(svg).not.toContain("columns</text>");
    expect(svg).not.toContain("uk_order_product");
  });

  it("is narrower than the full drawing", async () => {
    const all = await toSvg(modelOf(ORDER), elk);
    const names = await toSvg(modelOf(ORDER), elk, { columns: "none" });
    expect(names.width * names.height).toBeLessThan((all.width * all.height) / 2);
  });
});

describe("a part of a model", () => {
  it("keeps a column a foreign key when the table it points at is left out", async () => {
    const m = modelOf("table a {\n id bigint pk\n}\ntable b {\n id bigint pk\n a_id bigint -> a index\n}");
    const part = { tables: m.tables.filter((t) => t.name === "b"), relations: [], services: [] };
    const { svg } = await toSvg(part, elk);
    expect(svg).toMatch(/>FK<\/text><text[^>]*>a_id</);
  });
});

describe("services", () => {
  const SRC = `service ordering "Order service" {
  table orders {
    id       bigint  pk
    user_id  bigint  ~> users  index
  }
}
service accounts "Accounts service" {
  external table users {
    id  bigint  pk
  }
}
table shipments {
  id        bigint  pk
  order_id  bigint  -> orders  index
}`;

  it("draws an area around each service, with its name, and keeps the cards inside it", async () => {
    const { svg, boxes } = await toSvg(modelOf(SRC), elk, { look: "aurora-dark" });
    expect(count(svg, 'class="rz-svc"')).toBe(2);
    expect(svg).toContain('data-svc="ordering"');
    expect(svg).toContain(">ordering<tspan");
    // Hues follow the order of declaration; the tint is masked out where the cards are
    expect(svg).toMatch(/data-svc="ordering"><rect[^>]*fill="#5EEAD4"[^>]*mask="url\(#rz-areas\)"/);
    expect(svg).toMatch(/data-svc="accounts"><rect[^>]*fill="#C4B5FD"/);
    const area = /data-svc="ordering"><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/.exec(svg)!.slice(1).map(Number);
    const orders = boxes.find((b) => b.table === "ordering.orders")!;
    expect(orders.x).toBeGreaterThan(area[0]);
    expect(orders.y).toBeGreaterThan(area[1]);
    expect(orders.x + orders.w).toBeLessThan(area[0] + area[2]);
    expect(orders.y + orders.h).toBeLessThan(area[1] + area[3]);
    expect(count(svg, 'class="rz-r"')).toBe(2);
  });

  it("draws services in ink alone in graphite, and leaves out a service with no drawn table", async () => {
    const m = modelOf(SRC);
    const { svg } = await toSvg(m, elk);
    expect(svg).toMatch(/data-svc="ordering"><rect[^>]*fill="currentColor"/);
    const part = { ...m, tables: m.tables.filter((t) => t.name !== "accounts.users"), relations: m.relations.filter((r) => r.parent !== "accounts.users") };
    expect(count((await toSvg(part, elk)).svg, 'class="rz-svc"')).toBe(1);
  });

  it("gives a service's label a hit area of its own", async () => {
    const { svg } = await toSvg(modelOf(SRC), elk);
    expect(svg).toMatch(/data-svc="ordering">(?:<rect[^>]*>){2}<g class="rz-svc-head"><rect class="rz-hit"[^>]*\/><text[^>]*>ordering</);
  });
});

describe("folded services", () => {
  const SRC = `service ordering "Order service" {
  table orders {
    id        bigint  pk
    user_id   bigint  ~> users  index
    buyer_id  bigint  ~> users  index
  }

  table order_items {
    id        bigint  pk
    order_id  bigint  -> orders  index
  }
}
service accounts "Accounts service" {
  external table users {
    id  bigint  pk
  }
}
table shipments {
  id        bigint  pk
  order_id  bigint  -> orders  index
}`;
  const cardOf = (svg: string, id: string) => svg.split('<g class="rz-t" ').find((x) => x.startsWith(`data-t="${id}"`))!;

  it("draws each folded service as one card with a row per table, and counts the references inside it", async () => {
    const { svg, boxes } = await toSvg(modelOf(SRC), elk, { columns: "none", fold: ["ordering", "accounts"] });
    expect(boxes.map((b) => b.table)).toEqual(["service `ordering`", "service `accounts`", "shipments"]);
    const ordering = cardOf(svg, "service `ordering`");
    expect(ordering).toContain('data-svc="ordering"');
    expect(ordering).toContain('<g class="rz-c" data-c="orders" data-table="ordering.orders">');
    expect(ordering).toContain('<g class="rz-c" data-c="order_items" data-table="ordering.order_items">');
    expect(ordering).toContain(">3 columns</text>");
    expect(ordering).toContain(">1 reference inside</text>");
    expect(ordering).toContain("<title>orders\n3 columns</title>");
    // A row is a table, not a key: no PK, UK or FK in its gutter
    expect(ordering).not.toMatch(/>(PK|UK|FK)<\/text>/);
    // Every table of accounts lives elsewhere, so the card is external
    expect(cardOf(svg, "service `accounts`")).toContain(">EXTERNAL</text>");
    expect(cardOf(svg, "service `accounts`")).toContain('stroke-dasharray="5 4"');
    expect(count(svg, 'class="rz-svc"')).toBe(0);
  });

  it("joins the rows of the tables a reference crosses between, once per pair of rows", async () => {
    const { svg } = await toSvg(modelOf(SRC), elk, { columns: "none", fold: ["ordering", "accounts"] });
    // user_id and buyer_id both reach users: one connector. shipments, outside every service, keeps its own
    expect(count(svg, 'class="rz-r"')).toBe(2);
    const users = /<g class="rz-r" data-a="service `accounts`" data-ac="users" data-b="service `ordering`" data-bc="orders">[\s\S]*?<\/g>/.exec(svg)![0];
    // A connector into a row may stand for several references, so it carries no 1 or N
    expect(users).not.toMatch(/>(1|N)<\/text>/);
    const shipments = /<g class="rz-r" data-a="service `ordering`" data-ac="orders" data-b="shipments" data-bc="order_id">[\s\S]*?<\/g>/.exec(svg)![0];
    expect(shipments).toContain(">N</text>");
  });

  it("names and edges a folded card in its service's hue, and in ink in graphite", async () => {
    const dark = cardOf((await toSvg(modelOf(SRC), elk, { look: "aurora-dark", fold: ["ordering"] })).svg, "service `ordering`");
    expect(dark).toMatch(/letter-spacing="-0\.01em" fill="#5EEAD4">ordering</);
    expect(dark).toMatch(/fill="none" stroke="#5EEAD4" stroke-opacity="0\.42"/);
    // On a live canvas the glass is painted below; the edge in the hue is still drawn
    const live = cardOf((await toSvg(modelOf(SRC), elk, { look: "aurora-light", stage: false, fold: ["ordering"] })).svg, "service `ordering`");
    expect(live).toMatch(/fill="none" stroke="#0F766E" stroke-opacity="0\.38"/);
    const ink = cardOf((await toSvg(modelOf(SRC), elk, { fold: ["ordering"] })).svg, "service `ordering`");
    expect(ink).not.toContain("#5EEAD4");
  });

  it("gives a folded card an id no table's identity can have", async () => {
    const src = "service `a.b` {\n  table t {\n    id  int  pk\n  }\n}\ntable `a.b` {\n  id    int  pk\n  t_id  int  ~> t\n}";
    const { boxes } = await toSvg(modelOf(src), elk, { fold: ["a.b"] });
    expect(boxes.map((b) => b.table)).toEqual(["service `a.b`", "`a.b`"]);
  });

  it("draws the tables of the services it does not fold as they are, around the folded cards", async () => {
    const { svg } = await toSvg(modelOf(SRC), elk, { fold: ["accounts"] });
    expect(count(svg, 'class="rz-svc"')).toBe(1);
    expect(svg).toContain('data-t="ordering.orders"');
    // The column keeps its key and the connector its N: it is one reference
    const users = /<g class="rz-r" data-a="service `accounts`" data-ac="users" data-b="ordering.orders" data-bc="user_id">[\s\S]*?<\/g>/.exec(svg)![0];
    expect(users).toContain(">N</text>");
    expect(cardOf(svg, "ordering.orders")).toMatch(/>FK<\/text><text[^>]*>user_id</);
  });
});

describe("golden svg", () => {
  for (const file of readdirSync(EXAMPLES).filter((f) => f.endsWith(".erd")).sort()) {
    it(file, async () => {
      const { svg } = await toSvg(modelOf(readFileSync(join(EXAMPLES, file), "utf8")), elk, { standalone: true });
      await expect(svg + "\n").toMatchFileSnapshot(join(EXAMPLES, file.replace(/\.erd$/, ".svg")));
    });
  }
  for (const look of ["aurora-dark", "aurora-light"] as const) {
    it(`order.erd (${look})`, async () => {
      const { svg } = await toSvg(modelOf(ORDER), elk, { look });
      await expect(svg + "\n").toMatchFileSnapshot(join(EXAMPLES, `order.${look}.svg`));
    });
  }
});

it("routes a high-degree hub deterministically without dropping endpoints", async () => {
  const source = Array.from({ length: 40 }, (_, i) => `table t${i} {\n id int pk\n${i ? " parent_id int -> t0.id index\n" : ""}}`).join("\n");
  const model = modelOf(source);
  const first = await toSvg(model, elk);
  const next = await toSvg(model, elk);
  expect(next.svg).toBe(first.svg);
  expect(first.boxes).toHaveLength(40);
  expect(count(first.svg, 'class="rz-r"')).toBe(39);
  expect(first.svg).not.toMatch(/NaN|undefined/);
  for (const box of first.boxes) {
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.w).toBeLessThanOrEqual(first.width);
    expect(box.y + box.h).toBeLessThanOrEqual(first.height);
  }
});
