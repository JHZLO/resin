# Keys

`pk` marks the primary key, and `uk` a unique column.

```erd example file=accounts.erd
table accounts {
  id     bigint        pk
  email  varchar(255)  uk as uk_accounts_email
  phone  varchar(20)?  uk
}
```

## Primary keys

Write `pk` on the primary key's column. Write it on several columns for a composite primary key:

```erd example file=enrollments.erd "A composite primary key, each half also a foreign key"
table students {
  id  bigint  pk
}

table courses {
  id  bigint  pk
}

table enrollments {
  student_id   bigint    pk  -> students
  course_id    bigint    pk  -> courses  index
  enrolled_at  datetime
}
```

The primary key's index starts with `student_id`, so it serves lookups by student; `course_id` gets an `index` of its own, or finding a course's enrollments would read the whole table. [Lint](lint.md) reports a reference column that no index starts with.

A primary key cannot be nullable. A reference that leaves out the target column points at the primary key, so that table needs a single-column one.

## Unique columns

`uk` makes one column unique. Name the constraint with `as`, as in `uk as uk_accounts_email`. For a uniqueness that spans several columns, use the [table constraint](constraints.md) `unique(a, b)`.

A unique column that references another table makes the relation one-to-one; see [One or many](references.md#one-or-many).

## In the diagram

Keys sit in a gutter before the column name: `PK`, `UK`, and `FK` for a reference. In the playground's side panel, a column with only an index shows `IX` there.
