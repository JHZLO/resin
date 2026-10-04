# Migrating from v0.1

Version 0.2 changed a few forms. The parser still recognizes every v0.1 form and answers it with an error whose hint is the new way to write it, so a file can be migrated by following the errors.

| v0.1 | v0.2 |
|---|---|
| `erd` on the first line | Delete it |
| `index(idx_name)` | `index as idx_name` |
| `unique name(a, b)`, `index name(a, b)` | `unique(a, b) as name`, `index(a, b) as name` |
| `} audit(a, b)`, `} audit` | `} audit envers(a, b)`, `} audit envers` |
| A reference to another service written in a description | Declare an [external table](external-tables.md) and use `~>` |
| `group name { ... }`, which lasted a day before 0.2 | `service name { ... }` (see [Services](services.md)) |

The [playground](playground.md) makes the `group` change by itself when it opens a document it saved or a link made that day.

## Why the changes

Parentheses now only ever hold lists, and a name always follows `as`, so `index(a, b)` is always a composite index and `index as name` always names one. `audit` names its method, `envers`, so other kinds of audit can come later without changing the meaning of existing files.

## Service-scoped identities and composite references

Table names can repeat across services. Existing references still resolve when their short names are unambiguous. If a short name now matches more than one table, write the target as `service.table.column`.

Model `name`, relation endpoints, SVG `data-t` and layout boxes now use qualified service identities, such as `billing.orders`. `ModelTable.label` carries the short display name. Use the canonical identity for lookups and `label ?? name` for display. A table moved between services appears as a removal and an addition in a diff. Old shared related views are upgraded when their short name has a unique match.

Composite references have `childColumns` and `parentColumns` arrays on one relation, with an optional `constraint` name. The legacy singular column fields contain the first pair. Consumers should use the arrays when present.
