# Grammar

The grammar of resin v0.2. The [specification](https://github.com/JHZLO/resin/blob/main/docs/SPEC.md) in the repository is the definition of the language; this page is its grammar on one screen.

## Lexical structure

| Element | Form | Notes |
|---|---|---|
| Identifier | `[A-Za-z_][A-Za-z0-9_]*` | Tables, columns, types, names, enum values |
| Backtick identifier | `` `...` `` | Any characters except a backtick or a newline. Never a keyword |
| Number | `[0-9]+` | Only in type arguments and enum values |
| String | `"..."` | Two escapes, `\"` and `\\`. Must end on the same line |
| Comment | `%%` to the end of the line | As in Mermaid |
| Punctuation | `{ } ( ) , . ?` | |
| Reference arrows | `->` `~>` | Foreign key, logical reference |
| Newline | `\n` | Ends a statement. Ignored inside parentheses |

The keywords `table`, `external`, `pk`, `uk`, `enc`, `enum`, `index`, `unique`, `as` and `audit` are contextual: they are not reserved, and the position decides.

## Syntax

```ebnf
document    = { NL | table } EOF ;
table       = [ "external" ] "table" name [ STRING ] "{" { member | NL } "}" [ audit ] ( NL | EOF ) ;
member      = constraint | column ;

column      = name type { modifier } ( NL | "}" ) ;   (* "}" is not consumed, for one-line tables *)
type        = IDENT [ "(" NUMBER { "," NUMBER } ")" ] [ "?" ] ;
modifier    = "pk" | "enc"
            | "uk" [ "as" name ]
            | "index" [ "as" name ]
            | "enum" values
            | ( "->" | "~>" ) name [ "." name ]
            | STRING ;

constraint  = ( "unique" | "index" ) list [ "as" name ] ;  (* only when "(" directly follows the keyword *)
audit       = "audit" IDENT [ list ] ;
list        = "(" [ name { "," name } [ "," ] ] ")" ;
values      = "(" [ value { "," value } [ "," ] ] ")" ;
value       = name | NUMBER ;
name        = IDENT | QUOTED ;
```

## Everything at once

```erd example file=orders.erd "Every construct of the language"
%% Orders
external table users "Accounts service" {
  id  bigint  pk
}

table orders "Customer orders" {
  id          bigint       pk
  user_id     bigint       ~> users  "Customer"  index as idx_user_id
  order_no    varchar(32)  uk as uk_order_no  "Order number"
  buyer_name  varchar?     enc  "Buyer name"
  status      varchar      enum(PENDING, PAID, CANCELED)  index as idx_status
  created_at  datetime
  updated_at  datetime
} audit envers(user_id, status)

table order_items "Order lines" {
  id          bigint  pk
  order_id    bigint  -> orders.id  index as ix_order_id
  product_id  bigint  "Product in the catalog service"
  quantity    int
  created_at  datetime
  unique(order_id, product_id) as uk_order_product
}
```
