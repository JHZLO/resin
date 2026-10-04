import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "./index.ts";
import { tokenize } from "./sql-lexer.ts";
import { type SqlImportOptions, fromSql, looksLikeSql } from "./sql.ts";

const SQL = join(import.meta.dirname, "../examples/sql");

/** Convert, and check that the result is resin that compiles without an error */
const convert = (sql: string, options?: SqlImportOptions): string => {
  const { source } = fromSql(sql, options);
  expect(compile(source).diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return source;
};
/** The line of a column, with the alignment collapsed */
const line = (source: string, column: string): string =>
  source
    .split("\n")
    .find((l) => l.trim().split(/\s+/)[0] === column)!
    .trim()
    .replace(/\s{2,}/g, "  ");

describe("tokenize", () => {
  const values = (sql: string) => tokenize(sql).statements.map((s) => s.map((t) => t.value));

  it("reads names quoted every way, and strings with doubled or escaped quotes", () => {
    expect(values(`select "a b", [c d], x from t;`)[0]).toEqual(["select", "a b", ",", "c d", ",", "x", "from", "t"]);
    expect(values("select `a``b`, 'it''s', N'n' from t;")[0]).toEqual(["select", "a`b", ",", "it's", ",", "n", "from", "t"]);
    expect(values("select 'it\\'s' from `t`;")[0]).toContain("it's");
  });

  it("keeps [ before anything but a name as punctuation, for arrays", () => {
    expect(values("a text[], b int[3], c text DEFAULT ARRAY['x'];")[0]).toEqual([
      "a", "text", "[", "]", ",", "b", "int", "[", "3", "]", ",", "c", "text", "DEFAULT", "ARRAY", "[", "x", "]",
    ]);
  });

  it("skips comments but reads MySQL versioned comments as code", () => {
    const sql = "-- a\n# b\n/* c; */ create /*!50001 table */ t;\n";
    expect(values(sql)).toEqual([["create", "table", "t"]]);
  });

  it("ends statements at GO, at a lone slash and at a DELIMITER of its own", () => {
    expect(values("select 1\nGO\nselect 2\n/\nselect 3;").length).toBe(3);
    const proc = "DELIMITER ;;\nCREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END ;;\nDELIMITER ;\nselect 3;";
    expect(values(proc).map((s) => s[0])).toEqual(["CREATE", "select"]);
  });

  it("starts a statement at a CREATE or ALTER line when a semicolon is missing", () => {
    const sql = "create table a (id int)\ncreate table b (\n  id int\n)\nalter table b add x int";
    expect(values(sql).map((s) => s.slice(0, 3).join(" "))).toEqual(["create table a", "create table b", "alter table b"]);
  });

  it("reads dollar quotes whole, and skips psql meta-commands and COPY data", () => {
    const sql = "\\restrict k\ncreate function f() as $$ begin; end; $$;\nCOPY t (a) FROM stdin;\nx;'y\n\\.\nselect 1;";
    expect(values(sql)).toEqual([["create", "function", "f", "(", ")", "as", " begin; end; "], ["COPY", "t", "(", "a", ")", "FROM", "stdin"], ["select", "1"]]);
  });

  it("gives every token its line and column", () => {
    const [[a, b]] = tokenize("\n  create\n table").statements;
    expect([a.line, a.col, b.line, b.col]).toEqual([2, 3, 3, 2]);
  });
});

describe("fromSql: columns", () => {
  it("writes a column without NOT NULL as nullable, and a primary key as NOT NULL", () => {
    const out = convert("create table t (id int primary key, a int not null, b int, c int null);");
    expect(line(out, "id")).toBe("id  int  pk");
    expect(line(out, "a")).toBe("a  int");
    expect(line(out, "b")).toBe("b  int?");
    expect(line(out, "c")).toBe("c  int?");
  });

  it("normalizes types to one name with number arguments", () => {
    const out = convert(`create table t (
      a character varying(20), b double precision, c timestamp(6) with time zone, d time without time zone,
      e int(11) unsigned, f bigserial, g text[], h nvarchar(max), i varchar2(30 byte), j public.mood,
      k decimal(12, 2), l bit varying(4), m national character varying(8)
    );`);
    const types = out.split("\n").slice(1, -2).map((l) => l.trim().split(/\s+/)[1]);
    expect(types).toEqual(["varchar(20)?", "double?", "timestamptz(6)?", "time?", "int?", "bigint?", "_text?", "nvarchar?", "varchar2(30)?", "mood?", "decimal(12,2)?", "varbit(4)?", "nvarchar(8)?"]);
  });

  it("gives a column without a type (SQLite) the type any", () => {
    expect(line(convert("create table t (id integer primary key, meta);"), "meta")).toBe("meta  any?");
  });

  it("reads columns called key, index, unique or check as columns", () => {
    const out = convert("create table t (key varchar(10), index int, unique boolean, `check` text, primary boolean);");
    expect(out.split("\n").slice(1, -2).map((l) => l.trim().split(/\s+/)[0])).toEqual(["key", "index", "unique", "check", "primary"]);
  });

  it("does not read the NULL of ON DELETE SET NULL or GENERATED ... ON NULL as nullability", () => {
    const out = convert(`create table p (id int primary key);
      create table t (a int not null references p(id) on delete set null, b number generated by default on null as identity not null);`);
    expect(line(out, "a")).toBe("a  int  -> p");
    expect(line(out, "b")).toBe("b  number");
  });

  it("skips defaults, casts and vendor options without losing what follows", () => {
    const out = convert(`create table t (
      a varchar(10) default 'x'::character varying not null comment 'Code',
      b datetime(6) not null default current_timestamp(6) on update current_timestamp(6),
      c int identity(1,1) not null,
      d text collate "C" character set utf8mb4 default ('{}'::jsonb) not null
    );`);
    expect(line(out, "a")).toBe('a  varchar(10)  "Code"');
    expect(line(out, "b")).toBe("b  datetime(6)");
    expect(line(out, "c")).toBe("c  int");
    expect(line(out, "d")).toBe("d  text");
  });
});

describe("fromSql: keys and indexes", () => {
  it("collects primary keys from the column, the table and ALTER TABLE", () => {
    const out = convert(`create table a (id int primary key);
      create table b (x int, y int, primary key (x, y));
      create table c (id int); alter table only c add constraint c_pkey primary key (id);`);
    expect(line(out, "x")).toBe("x  int  pk");
    expect(line(out, "y")).toBe("y  int  pk");
    expect(out).toContain("table c {\n  id  int  pk\n}");
  });

  it("writes single-column uniques as uk and composite ones as unique(...)", () => {
    const out = convert(`create table t (
      id int primary key unique, a int unique, b int constraint uk_b unique, c int, d int,
      unique key uk_c (c), constraint uk_cd unique (c, d)
    ); create unique index ux_a on t (a);`);
    expect(line(out, "id")).toBe("id  int  pk");
    expect(line(out, "a")).toBe("a  int?  uk as ux_a");
    expect(line(out, "b")).toBe("b  int?  uk as uk_b");
    expect(line(out, "c")).toBe("c  int?  uk as uk_c");
    expect(out).toContain("  unique(c, d) as uk_cd\n");
  });

  it("writes single-column indexes on the column and composite ones as index(...)", () => {
    const out = convert(`create table public.t (id int primary key, a int, b int, key ix_a (a), index ix_ab (a, b));
      create index ix_b on public.t using btree (b desc);`);
    expect(line(out, "a")).toBe("a  int?  index as ix_a");
    expect(line(out, "b")).toBe("b  int?  index as ix_b");
    expect(out).toContain("  index(a, b) as ix_ab\n");
  });

  it("keeps an expression index as a comment, and draws a partial unique index as a plain one", () => {
    const { source, notes } = fromSql(`create table t (id int primary key, email text, user_id int);
      create index ix_lower on t (lower(email));
      create unique index ux_open on t (user_id) where deleted_at is null;`);
    expect(source).toContain("  %% Not converted: index ix_lower on (lower(email))\n");
    expect(source).toContain("  %% Partial unique index ux_open on (user_id) where deleted_at is null, drawn as a plain index\n");
    expect(line(source, "user_id")).toBe("user_id  int?  index as ux_open");
    expect(notes.map((n) => [n.line, n.message])).toEqual([
      [2, "table `t`: not converted: index ix_lower on (lower(email))"],
      [3, "table `t`: partial unique index ux_open on (user_id) where deleted_at is null, drawn as a plain index"],
    ]);
  });
});

describe("fromSql: references", () => {
  it("reads foreign keys from the column, the table and ALTER TABLE, wherever the target is declared", () => {
    const out = convert(`create table b (id int primary key, a_id int references a, c_id int, d_id int, foreign key (c_id) references a (code));
      alter table b add constraint fk foreign key (d_id) references a(id);
      create table a (id int primary key, code int unique);`);
    expect(line(out, "a_id")).toBe("a_id  int?  -> a");
    expect(line(out, "c_id")).toBe("c_id  int?  -> a.code");
    expect(line(out, "d_id")).toBe("d_id  int?  -> a");
  });

  it("matches bare and bracket names case-insensitively within the requested schema", () => {
    const out = convert("CREATE TABLE [dbo].[Users] ([Id] int PRIMARY KEY); CREATE TABLE orders (user_id int REFERENCES dbo.USERS (ID));");
    expect(line(out, "user_id")).toBe("user_id  int?  -> Users");
  });

  it("never substitutes a different schema for an explicitly qualified target", () => {
    const out = convert("create table stock.items (id int primary key); create table orders (item_id int references sales.items(id));");
    expect(out).toContain("external table `sales.items`");
    expect(line(out, "item_id")).toBe("item_id  int?  -> `sales.items`");
  });

  it("resolves unqualified references in the source schema and reports ambiguous targets", () => {
    const sql = `create table stock.items (id int primary key);
      create table sales.items (id int primary key);
      create table sales.orders (item_id int references items);
      create table orders (other_id int references items);`;
    const { source, notes } = fromSql(sql);
    expect(compile(source).model).not.toBeNull();
    expect(line(source, "item_id")).toBe("item_id  int?  -> `sales.items`");
    expect(line(source, "other_id")).toBe("other_id  int?");
    expect(notes.some((n) => n.line === 4 && n.message.includes("ambiguous"))).toBe(true);
  });

  it("keeps PostgreSQL double-quoted table and column names distinct", () => {
    const out = convert(`create table "Users" ("Id" int, id int, primary key ("Id"), unique(id));
      create table users (id int primary key);
      create table orders (a int references "Users"("Id"), b int references users(id), c int references "Users"(id));
      create index by_lower_id on "Users" (id);`);
    const model = compile(out).model!;
    expect(model.tables.map((t) => t.name)).toEqual(["Users", "users", "orders"]);
    expect(model.tables[0].columns.map((c) => [c.name, c.pk, c.uk, c.index?.name])).toEqual([
      ["Id", true, false, undefined], ["id", false, true, "by_lower_id"],
    ]);
    expect(model.relations.map((r) => [r.childColumn, r.parent, r.parentColumn])).toEqual([
      ["a", "Users", "Id"], ["b", "users", "id"], ["c", "Users", "id"],
    ]);
  });

  it("keeps external targets from different schemas separate", () => {
    const out = convert("create table orders (a int references crm.users(id), b int references billing.users(id));");
    expect(compile(out).model!.relations.map((r) => r.parent)).toEqual(["crm.users", "billing.users"]);
  });

  it("does not apply qualified alterations, indexes or comments to a different schema", () => {
    const { source, notes } = fromSql(`create table actual.users (id int primary key, name text);
      alter table missing.users add wrong int;
      create index wrong_index on missing.users(name);
      comment on column missing.users.name is 'wrong';`);
    expect(source).not.toContain("wrong");
    expect(notes.map((n) => n.line)).toEqual([2, 3, 4]);
    expect(notes.every((n) => n.message.includes("missing.users"))).toBe(true);
  });

  it("resolves quoted schemas, columns, comments and ALTER constraints by exact identity", () => {
    const out = convert(`create table "A"."Users" ("Id" int, id int);
      create table a."Users" (id int primary key);
      alter table "A"."Users" add primary key ("Id");
      alter table "A"."Users" alter column id set not null;
      comment on column "A"."Users"."Id" is 'Upper key';
      create table orders (u int references "A"."Users"("Id"));`);
    expect(line(out, "Id")).toBe('Id  int  pk  "Upper key"');
    expect(line(out, "u")).toBe("u  int?  -> `A.Users`");
    expect(compile(out).model!.tables).toHaveLength(3);
  });

  it("declares a referenced table that is not in the SQL as an external table", () => {
    const { source, notes } = fromSql("create table t (id int primary key, user_id bigint not null references users, org_id int references orgs (code));");
    expect(source).toContain("external table users {\n  id  bigint  pk\n}\n\nexternal table orgs {\n  code  int  pk\n}\n");
    expect(line(source, "user_id")).toBe("user_id  bigint  -> users");
    expect(notes.map((n) => n.message)).toEqual(["table `users` is not in the SQL; its primary key is taken to be `id`"]);
  });

  it("points at tables already in the document without declaring them", () => {
    const { source } = fromSql("create table t (id int primary key, user_id bigint references users (id));", { known: ["Users"] });
    expect(source).not.toContain("external");
    expect(line(source, "user_id")).toBe("user_id  bigint?  -> Users.id");
  });

  it("keeps a composite foreign key as a comment rather than splitting it", () => {
    const { source, notes } = fromSql(`create table s (shop int, sku int, primary key (shop, sku));
      create table t (id int primary key, shop int, sku int, foreign key (shop, sku) references s (shop, sku));`);
    expect(source).toContain("  %% Not converted: composite foreign key (shop, sku) -> s (shop, sku)\n}");
    expect(line(source, "shop")).toBe("shop  int  pk");
    expect(notes).toHaveLength(1);
  });

  it("infers logical references from column names only when asked, and only when the types match", () => {
    const sql = `create table users (id bigint primary key);
      create table categories (id bigint primary key, parent_category_id bigint);
      create table orders (id bigint primary key, buyer_user_id bigint, categoryId bigint, user_id varchar(36));`;
    expect(convert(sql)).not.toContain("~>");
    const out = convert(sql, { inferReferences: true });
    expect(out.startsWith("%% References written ~> were inferred from column names\n")).toBe(true);
    expect(line(out, "parent_category_id")).toBe("parent_category_id  bigint?  ~> categories");
    expect(line(out, "buyer_user_id")).toBe("buyer_user_id  bigint?  ~> users");
    expect(line(out, "categoryId")).toBe("categoryId  bigint?  ~> categories");
    expect(line(out, "user_id")).toBe("user_id  varchar(36)?");
  });

  it("does not infer a reference when several schemas or singular forms match", () => {
    for (const names of [["crm.users", "billing.users"], ["user", "users"]]) {
      const sql = `create table ${names[0]} (id bigint primary key);
        create table ${names[1]} (id int primary key);
        create table orders (user_id bigint);`;
      const { source, notes } = fromSql(sql, { inferReferences: true });
      expect(source).not.toContain("~>");
      expect(notes.some((n) => n.line === 3 && n.message.includes("ambiguous"))).toBe(true);
    }
  });

  it("does not replace an unresolved explicit foreign key with a guessed reference", () => {
    const { source, notes } = fromSql(`create table users (id bigint primary key);
      create table wrong (id bigint primary key);
      create table orders (user_id bigint references wrong(missing));`, { inferReferences: true });
    expect(source).not.toContain("~>");
    expect(notes.some((n) => n.message.includes("wrong has no column missing"))).toBe(true);
  });
});

describe("fromSql: values and descriptions", () => {
  it("reads enum values from MySQL enums, PostgreSQL enum types and value list checks", () => {
    const out = convert(`create type mood as enum ('sad', 'ok'); alter type mood add value 'in progress';
      create table t (
        a enum('X','Y') not null, b mood, c text check (c in ('p', 'q')), d varchar(9), e int, f text,
        constraint d_check check (((d)::text = any ((array['ON'::character varying, 'OFF'::character varying])::text[]))),
        check ([e]=0 or [e]=1), check (f <> '')
      );`);
    expect(line(out, "a")).toBe("a  enum  enum(X, Y)");
    expect(line(out, "b")).toBe("b  mood?  enum(sad, ok, `in progress`)");
    expect(line(out, "c")).toBe("c  text?  enum(p, q)");
    expect(line(out, "d")).toBe("d  varchar(9)?  enum(ON, OFF)");
    expect(line(out, "e")).toBe("e  int?  enum(0, 1)");
    expect(line(out, "f")).toBe("f  text?");
  });

  it("reads descriptions from COMMENT, COMMENT ON and SQL Server extended properties", () => {
    const out = convert(`create table public.t (id int primary key comment 'Key', note text) comment='Things';
      COMMENT ON COLUMN public.t.note IS 'Free "text"
      on two lines';
      create table dbo.u ([Id] int);
      EXEC sys.sp_addextendedproperty @name=N'MS_Description', @value=N'People', @level0type=N'SCHEMA', @level0name=N'dbo', @level1type=N'TABLE', @level1name=N'u';`);
    expect(out).toContain('table t "Things" {');
    expect(line(out, "id")).toBe('id  int  pk  "Key"');
    expect(line(out, "note")).toBe('note  text?  "Free \\"text\\" on two lines"');
    expect(out).toContain('table u "People" {');
  });
});

describe("fromSql: tables", () => {
  it("writes names resin cannot write bare in backticks", () => {
    const out = convert('create table "Order Details" ("unit price" int, `주문` int);');
    expect(out).toContain("table `Order Details` {");
    expect(out).toContain("  `unit price`  int?\n");
    expect(out).toContain("  `주문`        int?\n");
  });

  it("renames colliding sanitized table and column names and follows their references", () => {
    const sql = 'create table "a`b" ("x`y" int, x_y int, primary key ("x`y"));\n' +
      'create table a_b (id int primary key);\n' +
      'create table child (id int primary key, x int references "a`b"("x`y"));';
    const { source, notes } = fromSql(sql);
    const model = compile(source).model;
    expect(model).not.toBeNull();
    expect(new Set(model!.tables.map((t) => t.name)).size).toBe(3);
    const parent = model!.tables.find((t) => t.name !== "a_b" && t.name !== "child")!;
    expect(parent.columns.map((c) => c.name)).toEqual(["x_y_2", "x_y"]);
    expect(model!.relations[0]).toMatchObject({ parent: parent.name, parentColumn: "x_y_2" });
    expect(notes.filter((n) => n.message.includes("renamed"))).toHaveLength(2);
  });

  it("reports enum values that resin cannot represent", () => {
    const { source, notes } = fromSql("create table t (v enum('', 'a`b', 'valid'));" );
    expect(line(source, "v")).toBe("v  enum?  enum(valid)");
    expect(notes.filter((n) => n.message.includes("enum value"))).toHaveLength(2);
  });

  it("keeps the schema in the name when two schemas have a table of the same name", () => {
    const out = convert("create table sales.items (id int primary key); create table stock.items (id int primary key, sales_id int references sales.items);");
    expect(out).toContain("table `sales.items` {");
    expect(line(out, "sales_id")).toBe("sales_id  int?  -> `sales.items`");
  });

  it("writes the tables of each schema in a service when there are several schemas", () => {
    const out = convert(`create table sales.orders (id int primary key, customer_id int references crm.customers);
      create table crm.customers (id int primary key);
      create table sales.lines (id int primary key, order_id int references sales.orders);
      create table audit_log (id int primary key);`);
    expect(out).toBe(`service sales {
  table orders {
    id           int   pk
    customer_id  int?  -> customers
  }

  table lines {
    id        int   pk
    order_id  int?  -> orders
  }
}

service crm {
  table customers {
    id  int  pk
  }
}

table audit_log {
  id  int  pk
}
`);
  });

  it("makes no service when every table is in one schema", () => {
    expect(convert("create table public.a (id int primary key); create table public.b (id int primary key);")).not.toContain("service");
  });

  it("counts views, triggers and functions in a comment on top, and drops mysqldump's view placeholders", () => {
    const { source, notes } = fromSql(`create table t (id int primary key);
      /*!50001 CREATE TABLE v (id tinyint) */;
      /*!50001 CREATE ALGORITHM=UNDEFINED VIEW v AS select 1 */;
      create view w as select 1; create trigger tr after insert on t for each row begin end;`);
    expect(source.startsWith("%% Skipped: 2 views, 1 trigger\n\ntable t {")).toBe(true);
    expect(source).not.toContain("table v");
    expect(notes.map((n) => n.message)).toEqual(["skipped view `v`: resin draws tables", "skipped view `w`: resin draws tables", "skipped trigger `tr`: resin draws tables"]);
  });

  it("honors DROP TABLE and keeps the first of two tables created under one name", () => {
    const { source, notes } = fromSql("create table a (id int); drop table a; create table b (x int); create table b (y int);");
    expect(source).toBe("table b {\n  x  int?\n}\n");
    expect(notes.map((n) => n.message)).toEqual(["table `b` is created twice; the first is kept"]);
  });

  it("turns Hibernate Envers tables into audit envers", () => {
    const out = convert(`create table orders (id bigint primary key, status varchar(20), memo text, created_at datetime);
      create table payments (id bigint primary key, amount int);
      create table revinfo (rev integer not null primary key, revtstmp bigint);
      create table orders_aud (id bigint not null, rev integer not null, revtype tinyint, status varchar(20), status_mod bit, primary key (rev, id));
      create table payments_AUD (id bigint not null, rev integer not null, revtype tinyint, amount int, primary key (rev, id));`);
    expect(out).toContain("} audit envers(status)");
    expect(out).toContain("} audit envers\n");
    expect(out).not.toContain("revinfo");
    expect(out).not.toContain("_aud");
  });

  it("returns nothing for SQL without a table, and reports a CREATE TABLE it cannot read", () => {
    expect(fromSql("select 1; insert into t values (1);")).toEqual({ source: "", notes: [], tables: 0 });
    expect(fromSql("create table t as select 1;").notes).toEqual([
      { message: "skipped table `t`: it has no column list (CREATE TABLE ... AS or LIKE)", line: 1, col: 1 },
    ]);
  });

  it("reports broken SQL delimiters while keeping earlier complete tables", () => {
    for (const broken of ["create table b (id int", "/* unfinished", "create table b (v text default 'unfinished", 'create table "unfinished', "create function f() as $$ unfinished"]) {
      const { source, notes } = fromSql(`create table good (id int primary key);\n${broken}`);
      expect(source).toContain("table good {");
      expect(notes.some((n) => n.line === 2 && n.message.includes("unterminated"))).toBe(true);
    }
  });
});

describe("looksLikeSql", () => {
  it("tells SQL that creates a table from resin", () => {
    expect(looksLikeSql("CREATE TABLE users (id int);")).toBe(true);
    expect(looksLikeSql("create temporary table if not exists `a b` (\n id int\n)")).toBe(true);
    expect(looksLikeSql('table users "People" {\n  id bigint pk\n}')).toBe(false);
    expect(looksLikeSql("select * from users")).toBe(false);
  });
});

// Golden files: examples/sql/<dialect>.sql → examples/sql/<dialect>.erd. Review the diff, then update
// with `pnpm test -u` only when the change is intended.
describe("golden sql", () => {
  for (const file of readdirSync(SQL).filter((f) => f.endsWith(".sql")).sort())
    it(file, async () => {
      const { source } = fromSql(readFileSync(join(SQL, file), "utf8"));
      expect(compile(source).diagnostics).toEqual([]);
      await expect(source).toMatchFileSnapshot(join(SQL, file.replace(/\.sql$/, ".erd")));
    });
});
