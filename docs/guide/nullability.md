# Nullability

Every column is NOT NULL unless its type ends in `?`.

```erd example file=users.erd "nickname and deleted_at may be empty; the card marks them NULL"
table users {
  id          bigint        pk
  email       varchar(255)  uk
  nickname    varchar(50)?  "Shown next to comments"
  deleted_at  datetime?
}
```

A column without `?` is a claim, not a default you forgot to fill in: resin reads it as NOT NULL, draws it so, and uses it to work out relations.

## In the diagram

A nullable column is marked `NULL` after its type, as in DDL. A card with any nullable column keeps a narrow column for the mark, so the types stay aligned. In the playground's side panel the Null column says `NULL` or `NOT NULL` for every column.

## Keys and references

A primary key cannot be nullable. resin reports `primary key ... cannot be nullable`, with a hint to remove the `?`.

On a referencing column, `?` makes the parent optional: a row may have no parent at all. See [Must a parent exist?](references.md#must-a-parent-exist).
