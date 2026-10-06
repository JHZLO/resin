# Formatting

resin has one layout. `resin fmt` and the playground's Format button rewrite a document in it, so two people who write the same schema write the same text, and a change to a file shows only the lines it changes.

```bash
pnpm resin fmt schema.erd
```

This document:

```erd
%% Orders
service ordering "Order service" {
table orders {
id bigint pk
user_id bigint ~> users index as ix_user_id
status varchar enum(PENDING,PAID) %% more to come
total decimal(12, 2)
}
table order_items { id bigint pk
order_id bigint -> orders index }
}
external table users { id bigint pk }
```

is formatted as:

```erd
%% Orders
service ordering "Order service" {
  table orders {
    id       bigint         pk
    user_id  bigint         ~> users  index as ix_user_id
    status   varchar        enum(PENDING, PAID)  %% more to come
    total    decimal(12,2)
  }

  table order_items {
    id        bigint  pk
    order_id  bigint  -> orders  index
  }
}

external table users {
  id  bigint  pk
}
```

## The layout

- One statement per line: a table written on one line is written over several.
- Two spaces of indentation per block, so four for the columns of a table in a service.
- The columns of a table line up: names, then types, each padded to the longest of the table plus two spaces, then the modifiers, two spaces apart. A wide character, such as Hangul, counts as two cells, as in a monospace editor.
- One space between words, none inside parentheses or around a dot, and `(` right after a name: `varchar(32)`, `enum(PENDING, PAID)`, `unique(a, b)`, `-> sales.orders.id`. Type arguments have no space after the comma: `decimal(12,2)`.
- At most one blank line in a row, none at the start or end of a block, and one after each table or service that something follows. A blank line between groups of columns is kept.
- Comments stay where they are: a comment line takes the indentation of its block, and a comment after a statement follows it after two spaces.
- A list written over several lines, such as a long `enum(...)`, keeps its line breaks.

Names, strings, backtick names and comments are kept exactly as written, and modifiers stay in the order they were written. Only whitespace changes.

## Guarantees

- Only a document without syntax errors is formatted. A file with one is left as it is, and the errors are printed.
- The formatted document says the same thing: resin parses the result again and compares it with the source before it writes anything, comments included.
- Formatting a formatted document changes nothing.

## In CI

`--check` changes nothing. It prints the files that are not formatted and exits with status 1 when there is one:

```bash
pnpm resin fmt --check schemas/*.erd
```

## In the playground

Format, at the top of the editor, or Shift + Alt + F formats the document. Ctrl or Cmd + Z undoes it in one step.

## In code

`format(source)` returns `{ text, diagnostics }`: the formatted document, or `null` and the syntax errors. See [Library](library.md).
