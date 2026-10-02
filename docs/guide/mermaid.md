# Mermaid

With no options, resin prints Mermaid `erDiagram` source, for anywhere Mermaid renders: GitHub, GitLab and most docs sites.

```erd output=mermaid
table users {
  id  bigint  pk
}

table orders {
  id       bigint  pk
  user_id  bigint  -> users  "Customer"
  memo     text?
}
```

## How facts map

Mermaid has no place for many of resin's facts, so each goes where Mermaid can carry it.

| resin | Mermaid `erDiagram` |
|---|---|
| `table t "description"` | `t["t (description)"] { ... }`; without a description, `t { ... }` |
| `external table u` | `:::external` on the block line, and `classDef external stroke-dasharray:4 3` at the end |
| `a_id bigint -> a.id`, in `b` | `a \|\|--o{ b : "a_id"`, and the attribute `bigint a_id FK "-> a.id"` |
| `~>` | A dotted line, `..` |
| A one-to-one reference | The right end `o\|` |
| A nullable referencing column | The left end `\|o` |
| The type | As written: `varchar(32)?` |
| `pk`, `uk`, a reference | The key markers `PK`, `UK`, `FK`, in the order PK, FK, UK |
| A description, `enc`, `enum` | The attribute comment: `"description (enc) A/B"` |
| A reference's target | Then `; -> a.id` |
| `index`, `index as n`, `uk as n` | `(ix)` or `(n)` at the end of the comment |
| `unique(a, b)`, `unique(a, b) as n` | `uk(a,b)` or `n(a,b)` in the comment of the first column |
| `index(a, b)`, `index(a, b) as n` | `ix(a,b)` or `n(a,b)` in the comment of the first column |
| `audit envers` | A `revinfo` block, `<table>_aud` blocks, and `revinfo \|\|..o{ <table>_aud : "Envers rev"` |

## Names

Mermaid cannot read some names as they are, so resin rewrites them:

- A table name that is not a plain ASCII identifier, or is a Mermaid keyword (`class`, `classDef`, `style`, `erDiagram`, `direction`, `accTitle`, `accDescr`, `title`, `to`, `one`, `many`, in any case), is written in double quotes.
- A column name cannot be quoted in Mermaid. Characters other than letters, digits, `_` and `-` become `_`; a leading digit or `-` gets a `_` in front; `pk`, `fk` and `uk`, in any case, get a `_` after. When a name had to change, its original is written in backticks at the start of its comment.
- A `"` inside a string becomes `#quot;`, because Mermaid has no `\"` escape.

## Output order

`erDiagram`, then a legend comment when there are references, the domain relations in document order, a blank line, the audit relations, the entity blocks in document order with external tables included, `revinfo`, the `*_aud` blocks, and the `classDef`. The same input always gives byte-identical output, tested against Mermaid 11.16.
