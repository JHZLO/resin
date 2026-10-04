// resin's syntax tree. Built by the parser (parser.ts), read by the checker (checker.ts) and the
// model (model.ts).
//
// Every node carries its source position (span): diagnostics, and later editor features such as
// hover and go-to, need to know which characters a node came from. The grammar itself is defined in
// docs/SPEC.md.

/** A source position. Lines and columns start at 1. Spans stay on one line (multi-line nodes keep their first line). */
export interface Span {
  line: number;
  col: number;
  /** Length in UTF-16 code units. 0 marks a single point */
  len: number;
}

/** A name with its position, so a diagnostic like "no such column" can point at it */
export interface Ident {
  text: string;
  span: Span;
  /** Written in backticks. Never read as a keyword */
  quoted?: boolean;
}

export interface Document {
  /** Every table in document order, inside a service or not */
  tables: Table[];
  /** In document order */
  services: Service[];
}

/** `service name "description" { tables }`: the tables one service owns, in a database of its own.
 *  Drawn as an area */
export interface Service {
  name: Ident;
  description: string | null;
  /** The `service` keyword */
  span: Span;
}

export interface Table {
  name: Ident;
  /** `external table`: lives outside this document and only receives references */
  external: boolean;
  /** Human-readable description (`table orders "Customer orders"`), or null */
  description: string | null;
  columns: Column[];
  constraints: TableConstraint[];
  audit: Audit | null;
  /** The name of the service the table is written in, or null */
  service: Ident | null;
  span: Span;
}

export interface TypeRef {
  name: Ident;
  /** Arguments of `varchar(32)` or `decimal(12,2)`, or null */
  args: number[] | null;
  span: Span;
}

export interface Column {
  name: Ident;
  type: TypeRef;
  nullable: boolean;
  pk: boolean;
  /** `uk` or `uk as name`, or null */
  uk: { name: Ident | null; span: Span } | null;
  enc: boolean;
  /** `enum(A, B)` or `enum(0, 1)`, or null */
  enumValues: EnumValue[] | null;
  /** `index` or `index as name`, or null; name is null when the index name is unknown */
  index: { name: Ident | null; span: Span } | null;
  ref: Ref | null;
  description: string | null;
  span: Span;
}

export interface EnumValue {
  text: string;
  span: Span;
}

export interface Ref {
  /** physical = `->` (a FOREIGN KEY constraint), logical = `~>` (application-level reference) */
  kind: "physical" | "logical";
  table: Ident;
  /** null when omitted; the checker resolves it to the target's single primary key */
  column: Ident | null;
  span: Span;
}

export interface TableConstraint {
  kind: "unique" | "index";
  name: Ident | null;
  columns: Ident[];
  span: Span;
}

export interface Audit {
  /** The audit method. Only `envers` exists today */
  method: Ident;
  /** null when written without a list: every column except the primary key, created_at and updated_at */
  columns: Ident[] | null;
  span: Span;
}

/** `varchar(32)`: the type name with its arguments, as written */
export const typeText = (t: TypeRef): string => (t.args ? `${t.name.text}(${t.args.join(",")})` : t.name.text);
