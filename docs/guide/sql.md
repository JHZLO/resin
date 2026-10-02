# Importing SQL

resin reads the DDL of a schema you already have and writes it as resin. Paste a `CREATE TABLE` script into the playground, or convert a file on the command line.

## From SQL to resin

Here is a MySQL script:

```sql
CREATE TABLE users (
  id     bigint       NOT NULL AUTO_INCREMENT,
  email  varchar(255) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_email (email)
) COMMENT='People who sign in';

CREATE TABLE orders (
  id          bigint    NOT NULL AUTO_INCREMENT,
  user_id     bigint    NOT NULL COMMENT 'Who placed it',
  coupon_id   bigint,
  status      enum('PENDING','PAID','CANCELED') NOT NULL DEFAULT 'PENDING',
  memo        text,
  created_at  datetime  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY ix_user_status (user_id, status),
  CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_orders_coupon FOREIGN KEY (coupon_id) REFERENCES coupons (id)
) COMMENT='Customer orders';

CREATE VIEW paid_orders AS SELECT * FROM orders WHERE status = 'PAID';
```

resin writes it as:

```erd example file=orders.erd "coupons is not in the script, so it becomes an external table"
%% Skipped: 1 view

external table coupons {
  id  bigint  pk
}

table users "People who sign in" {
  id     bigint        pk
  email  varchar(255)  uk as uk_email
}

table orders "Customer orders" {
  id          bigint    pk
  user_id     bigint    -> users  "Who placed it"
  coupon_id   bigint?   -> coupons
  status      enum      enum(PENDING, PAID, CANCELED)
  memo        text?
  created_at  datetime
  index(user_id, status) as ix_user_status
}
```

A column without `NOT NULL` may be empty in SQL, so it gets a `?`. The keys and indexes listed under the columns move onto the columns they cover, a foreign key becomes `->`, and the comments become descriptions. `AUTO_INCREMENT` and `DEFAULT` are left out: a diagram does not show them. `coupons` is referenced but not created here, so resin declares it as an [external table](external-tables.md) with the one column the reference points at.

## Where to paste it

In the [playground](playground.md), paste the SQL into the editor. It comes in as resin, and the line under the editor's header says how many tables were converted and takes you to the notes the conversion left. In an empty editor, or over an example you have not changed, it takes the whole document. Into a document of your own it goes where you paste it, and references to the tables already there point at them instead of adding external tables. One undo (Ctrl or Cmd + Z) brings back the SQL exactly as you pasted it.

On the command line, `--from-sql` prints the resin on standard output and lists what did not convert, with its line in the SQL, on standard error:

```bash
pnpm resin schema.sql --from-sql > schema.erd
```

In code, `fromSql(sql)` returns `{ source, notes, tables }`; see [Library](library.md).

## Dialects

There is no dialect to choose. One reader takes MySQL and MariaDB (including `mysqldump` files), PostgreSQL (including `pg_dump` plain dumps), SQLite, SQL Server (scripts with `GO`) and Oracle, because the ways they quote names and write comments rarely collide: names in `"..."`, `` `...` `` or `[...]`, comments after `--`, inside `/* */` or, at the start of a line, after `#`.

Statements are read one at a time, so one that cannot be read costs only itself. Tables are collected first and everything said about them afterwards, so it does not matter whether a dump puts its keys, indexes and comments before or after the tables. A line that starts with `CREATE` or `ALTER` begins a new statement even when the one before it has no semicolon, which helps with DDL copied out of a database tool.

## How facts carry over

| SQL | resin |
|---|---|
| `NOT NULL`, or part of the primary key | No `?` |
| Neither | `?` |
| `PRIMARY KEY`, on the column, in the table, or added by `ALTER TABLE` | `pk` on each of its columns |
| `UNIQUE` on one column, `UNIQUE KEY n (a)`, `CREATE UNIQUE INDEX n ON t (a)` | `uk as n` on `a` |
| The same over several columns | `unique(a, b) as n` |
| `KEY n (a)`, `INDEX n (a)`, `CREATE INDEX n ON t (a)` | `index as n` on `a` |
| The same over several columns | `index(a, b) as n` |
| `REFERENCES t (c)` or `FOREIGN KEY (a) REFERENCES t (c)`, also in `ALTER TABLE` | `-> t` when `c` is the primary key of `t`, `-> t.c` otherwise |
| A reference to a table the SQL does not create | An `external table` with the columns pointed at |
| MySQL `enum('A', 'B')` | Type `enum` with `enum(A, B)` |
| PostgreSQL `CREATE TYPE s AS ENUM ('A', 'B')` | Type `s` with `enum(A, B)` |
| `CHECK (c IN ('A', 'B'))`, and the forms pg_dump and SQL Server write for it | `enum(A, B)` |
| `COMMENT '...'`, `COMMENT='...'`, `COMMENT ON TABLE` and `COLUMN`, SQL Server's `MS_Description` | The description |
| `revinfo` and `<table>_aud` (Hibernate Envers) | `audit envers(...)` on `<table>` |

Names are matched without regard to case or schema, as most databases do, and written the way the `CREATE TABLE` spells them. A name resin cannot write bare goes in backticks (`` `Order Details` ``). When two schemas have a table of the same name, both keep their schema (`` `sales.items` ``).

## Types

A type becomes one lowercase name with number arguments.

| SQL | resin |
|---|---|
| `character varying(20)`, `double precision` | `varchar(20)`, `double` |
| `timestamp with time zone`, `timestamp without time zone` | `timestamptz`, `timestamp` |
| `serial`, `bigserial` | `integer`, `bigint` |
| `int(11)`, `bigint(20) unsigned` | `int`, `bigint`: display widths and `unsigned` do not change the type |
| `text[]` | `_text`, PostgreSQL's own name for the array type |
| `nvarchar(max)`, `varchar2(30 byte)` | `nvarchar`, `varchar2(30)` |
| `public.order_status` | `order_status` |
| A SQLite column with no type | `any` |

## What is left out

Some of what DDL says never shows in a diagram, and is dropped: defaults, `AUTO_INCREMENT` and identity, checks other than value lists, `ON DELETE` and `ON UPDATE`, collations, storage and partition options, sequences, privileges and data. Views, triggers, functions and procedures are not drawn either; a comment at the top counts them.

What a diagram would show but resin cannot write yet stays in its table as a `%%` comment, and is listed among the notes:

```erd
table order_items {
  order_id  bigint   pk  -> orders
  line      integer  pk
  shop_id   bigint?
  sku       text?
  %% Not converted: composite foreign key (shop_id, sku) -> shop_items (shop_id, sku)
}

table orders {
  id  bigint  pk
}
```

That covers foreign keys over several columns, indexes on expressions (`lower(email)`), and partial unique indexes (`WHERE deleted_at IS NULL`), which are drawn as plain indexes: they are unique only among some rows.

## Logical references

Many schemas keep references only in the application, with no `FOREIGN KEY` behind them. `--infer-refs` on the command line, or `inferReferences: true` in code, reads them from column names and writes them as [logical references](references.md) (`~>`).

A column called `<name>_id` or `<name>Id` that has no foreign key points at the table named after it, singular or plural, when that table has a one-column primary key of the same type: `user_id` points at `users`, `categoryId` at `categories`. A word or two in front are taken as a role, so `buyer_user_id` points at `users` too. The output says on its first line that the references were inferred. Names are only a guess, so this is off unless you ask for it.
