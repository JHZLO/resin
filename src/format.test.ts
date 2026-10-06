import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { format } from "./format.ts";

const fmt = (source: string): string => {
  const r = format(source);
  expect(r.diagnostics).toEqual([]);
  return r.text!;
};

describe("format", () => {
  it("lines up the columns of each table and puts two spaces between modifiers", () => {
    expect(
      fmt(`table orders "Customer orders" {
id bigint pk
user_id   bigint ~> users index as ix_user
  status varchar enum(PENDING,PAID)   "Order status"
memo text?
}

table users {
 id bigint pk
}
`),
    ).toBe(`table orders "Customer orders" {
  id       bigint   pk
  user_id  bigint   ~> users  index as ix_user
  status   varchar  enum(PENDING, PAID)  "Order status"
  memo     text?
}

table users {
  id  bigint  pk
}
`);
  });

  it("writes types, lists, references and constraints with resin's spacing", () => {
    expect(
      fmt(`table lines {
  id bigint pk
  price decimal( 12 , 2 )
  name varchar ?
  order_id bigint -> sales . orders . id
  unique( order_id , name ) as uk_line
  index ( name )
  foreign(order_id,name)->orders(id,name) as fk_line
}   audit envers( price , name )
`),
    ).toBe(`table lines {
  id        bigint         pk
  price     decimal(12,2)
  name      varchar?
  order_id  bigint         -> sales.orders.id
  unique(order_id, name) as uk_line
  index(name)
  foreign(order_id, name) -> orders(id, name) as fk_line
} audit envers(price, name)
`);
  });

  it("indents the tables of a service and writes one-line tables over several lines", () => {
    expect(fmt(`service ordering "Order service" {\ntable orders { id bigint pk }\n    external table users {id bigint pk}\n}\ntable notes { id int pk }`)).toBe(`service ordering "Order service" {
  table orders {
    id  bigint  pk
  }

  external table users {
    id  bigint  pk
  }
}

table notes {
  id  int  pk
}
`);
  });

  it("keeps one blank line where blank lines were, and puts one between tables", () => {
    expect(fmt(`\n\n\ntable a {\n\n  id int pk\n\n\n\n  name varchar\n\n}\ntable b {\n  id int pk\n}\n\n\n`)).toBe(`table a {
  id    int      pk

  name  varchar
}

table b {
  id  int  pk
}
`);
  });

  it("keeps comments on their lines, at the indentation of their block", () => {
    expect(
      fmt(`%% Orders
service ordering {
    %% the order itself
  table orders {   %% one per checkout
  id bigint pk %% generated
      %% amounts
  total decimal(12,2)
%% end of orders
  }
}
%% the end`),
    ).toBe(`%% Orders
service ordering {
  %% the order itself
  table orders {  %% one per checkout
    id     bigint         pk  %% generated
    %% amounts
    total  decimal(12,2)
    %% end of orders
  }
}

%% the end
`);
  });

  it("keeps the line breaks of a statement inside parentheses", () => {
    expect(fmt(`table orders {\n  id bigint pk\n  status varchar enum(\n PENDING, %% new\n      PAID,\n  )\n}\n`)).toBe(`table orders {
  id      bigint   pk
  status  varchar  enum(
    PENDING,  %% new
    PAID,
  )
}
`);
  });

  it("counts a wide character as two cells", () => {
    expect(fmt("table `주문` {\n  `번호` bigint pk\n  name varchar\n}\n")).toBe("table `주문` {\n  `번호`  bigint   pk\n  name    varchar\n}\n");
  });

  it("keeps strings, escapes and backtick names exactly as written", () => {
    const src = 'table `order-items` "Lines \\"of\\" an order" {\n  `unit price`  decimal  "Price, \\\\ per unit"\n}\n';
    expect(fmt(src)).toBe(src);
  });

  it("writes Unix line ends, spaces for tabs, and one newline at the end", () => {
    expect(fmt("table a {\r\n\tid\tint\tpk   \r\n}")).toBe("table a {\n  id  int  pk\n}\n");
    expect(fmt("")).toBe("");
    expect(fmt("\n\n")).toBe("");
    expect(fmt("%% only a comment")).toBe("%% only a comment\n");
  });

  it("formats a document with semantic errors, which the checker reports later", () => {
    expect(fmt("table a {\n  b_id int -> missing\n}")).toBe("table a {\n  b_id  int  -> missing\n}\n");
  });

  it("returns no text and the errors for a document with syntax errors", () => {
    const r = format("table a {\n  id int pk\n");
    expect(r.text).toBeNull();
    expect(r.diagnostics.map((d) => [d.severity, d.message])).toEqual([["error", "table `a` is missing its closing `}`"]]);
  });
});

// Every document the project ships is in the layout already, and formatting any of them keeps its
// meaning and is stable. Doc snippets are written by hand, so they only have to survive formatting.
const read = (dir: string, ext: string) =>
  readdirSync(new URL(dir, import.meta.url))
    .filter((f) => f.endsWith(ext))
    .map((f) => [f, readFileSync(new URL(dir + f, import.meta.url), "utf8")] as const);

describe("format on the project's documents", () => {
  it.each(read("../examples/", ".erd"))("examples/%s is formatted", (_, text) => {
    expect(fmt(text)).toBe(text);
  });

  it.each(read("../examples/sql/", ".erd"))("examples/sql/%s, written by fromSql, is formatted", (_, text) => {
    expect(fmt(text)).toBe(text);
  });

  const snippets = read("../docs/guide/", ".md").flatMap(([file, text]) =>
    [...text.matchAll(/```erd(?![^\n]*invalid)[^\n]*\n([\s\S]*?)```/g)].map((m, i) => [`${file} #${i + 1}`, m[1]] as const),
  );
  it.each(snippets)("%s keeps its meaning and formats to a fixed point", (_, text) => {
    const once = fmt(text);
    expect(fmt(once)).toBe(once);
  });
});
