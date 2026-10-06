// Source text → the same document in resin's one layout (docs/SPEC.md §11).
//
// The syntax tree drops comments and blank lines, so the formatter works on the tokens and their
// lines instead: it only changes the whitespace between tokens and prints each token as it was
// written. Comments are whatever follows the last token of a line. Before the result is returned it
// is parsed again and compared with the source, so a bug here can never change what a document says.

import type { Diagnostic } from "./diagnostics.ts";
import { type Token, lex } from "./lexer.ts";
import { parse } from "./parser.ts";

export interface FormatResult {
  /** The formatted document, or null when the source has syntax errors */
  text: string | null;
  /** The syntax errors that stopped formatting; empty otherwise */
  diagnostics: Diagnostic[];
}

/** Cells a string takes in a monospace editor: a wide character (Hangul, CJK) takes two */
export const cells = (s: string): number =>
  s.length + (s.match(/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/g)?.length ?? 0);

/** What a comment can follow: the line it ends */
interface Commented {
  comment: string | null;
}
interface Segment extends Commented {
  tokens: Token[];
}
/** The widths a table's columns are padded to */
interface Widths {
  name: number;
  type: number;
}
/** A column line split into the cells that line up */
interface ColumnCells {
  name: string;
  type: string;
  modifiers: string[];
}
type Statement = { kind: "statement"; depth: number; segments: Segment[]; table: Widths | null; column: ColumnCells | null };
/** `}` and what follows it on its line, `} audit envers(a, b)`, which may go on over several lines */
type Close = { kind: "close"; depth: number; segments: Segment[] };
type Item =
  | { kind: "blank" }
  | { kind: "comment"; depth: number; text: string }
  | ({ kind: "open"; depth: number; tokens: Token[]; table: Widths | null } & Commented)
  | Close
  | Statement;

export function format(source: string): FormatResult {
  const text = source.replace(/\r\n?/g, "\n");
  const parsed = parse(text);
  const errors = parsed.diagnostics.filter((d) => d.severity === "error");
  if (errors.length) return { text: null, diagnostics: errors };

  const lines = text.split("\n");
  const { tokens } = lex(text);
  const tokenText = (t: Token): string => lines[t.span.line - 1].slice(t.span.col - 1, t.span.col - 1 + t.span.len);
  const onLine: Token[][] = lines.map(() => []);
  for (const t of tokens) if (t.kind !== "newline" && t.kind !== "eof") onLine[t.span.line - 1].push(t);

  // ---- tokens → items: one per output line, before blank lines are settled ----

  const items: Item[] = [];
  /** The open blocks: a table's widths, or null for a service */
  const blocks: (Widths | null)[] = [];
  let statement: Statement | null = null;
  let closing: Close | null = null;
  let parens = 0;
  const end = () => {
    if (statement) {
      const { table } = statement;
      statement.column = table ? columnCells(statement.segments[0].tokens, tokenText) : null;
      if (statement.column && table) {
        table.name = Math.max(table.name, cells(statement.column.name));
        table.type = Math.max(table.type, cells(statement.column.type));
      }
      items.push(statement);
    }
    statement = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const comment = commentAfter(lines[i], onLine[i]);
    // Inside parentheses a line goes on the statement (or the `}` line) it continues; a blank one is dropped
    const going: Statement | Close | null = parens > 0 ? (closing ?? statement) : null;
    if (!onLine[i].length) {
      if (going) {
        if (comment) going.segments.push({ tokens: [], comment });
      } else items.push(comment ? { kind: "comment", depth: blocks.length, text: comment } : { kind: "blank" });
      continue;
    }
    if (going) going.segments.push({ tokens: [], comment: null });
    let last: Commented | null = null;
    for (const t of onLine[i]) {
      if (parens === 0 && t.kind === "lbrace") {
        const header = statement ? statement.segments.flatMap((s) => s.tokens) : [];
        statement = null;
        const isTable = header.some((h) => word(h, "table")) && !word(header[0], "service");
        const open: Item = { kind: "open", depth: blocks.length, tokens: header, table: isTable ? { name: 0, type: 0 } : null, comment: null };
        items.push(open);
        blocks.push(open.table);
        last = open;
      } else if (parens === 0 && t.kind === "rbrace") {
        end();
        blocks.pop();
        closing = { kind: "close", depth: blocks.length, segments: [{ tokens: [], comment: null }] };
        items.push(closing);
        last = closing.segments[0];
      } else {
        statement ??= closing ? null : { kind: "statement", depth: blocks.length, segments: [{ tokens: [], comment: null }], table: blocks.at(-1) ?? null, column: null };
        const segment = (closing ?? statement!).segments.at(-1)!;
        segment.tokens.push(t);
        last = segment;
        if (t.kind === "lparen") parens++;
        else if (t.kind === "rparen") parens--;
      }
    }
    if (parens === 0) {
      end();
      closing = null;
    }
    if (comment && last) last.comment = comment;
  }
  end();

  // ---- blank lines: one at most, none at the edges of a block, one after a table or service ----

  const settled: Item[] = [];
  for (const item of items) {
    const prev = settled.at(-1);
    if (item.kind === "blank") {
      if (prev && prev.kind !== "blank" && prev.kind !== "open") settled.push(item);
      continue;
    }
    if (item.kind === "close" && prev?.kind === "blank") settled.pop();
    if (prev?.kind === "close" && item.kind !== "close") settled.push({ kind: "blank" });
    settled.push(item);
  }
  while (settled.at(-1)?.kind === "blank") settled.pop();

  // ---- items → lines ----

  const indent = (depth: number) => "  ".repeat(depth);
  const withComment = (line: string, c: string | null) => (c ? (line.trim() ? `${line}  ${c}` : line + c) : line);
  const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - cells(s)));
  const out: string[] = [];
  /** The lines of a statement after its first: two spaces deeper, a `)` back at the statement's */
  const continued = (segments: Segment[], depth: number) => {
    for (const s of segments) {
      const back = s.tokens[0]?.kind === "rparen";
      out.push(withComment(indent(depth + (back ? 0 : 1)) + join(s.tokens, tokenText), s.comment));
    }
  };
  for (const item of settled) {
    if (item.kind === "blank") out.push("");
    else if (item.kind === "comment") out.push(indent(item.depth) + item.text);
    else if (item.kind === "open") out.push(withComment(`${indent(item.depth)}${join(item.tokens, tokenText)} {`, item.comment));
    else if (item.kind === "close") {
      const [first, ...rest] = item.segments;
      out.push(withComment(`${indent(item.depth)}}${first.tokens.length ? ` ${join(first.tokens, tokenText)}` : ""}`, first.comment));
      continued(rest, item.depth);
    } else {
      const [first, ...rest] = item.segments;
      const { column, table } = item;
      const head =
        column && table
          ? `${pad(column.name, table.name)}  ${pad(column.type, table.type)}  ${column.modifiers.join("  ")}`.trimEnd()
          : join(first.tokens, tokenText);
      out.push(withComment(indent(item.depth) + head, first.comment));
      continued(rest, item.depth);
    }
  }
  const formatted = out.length ? out.map((l) => l.trimEnd()).join("\n") + "\n" : "";

  // A formatter must never change what a document says: the same tree apart from positions, the same comments
  const again = parse(formatted);
  if (again.diagnostics.some((d) => d.severity === "error") || shape(again.doc) !== shape(parsed.doc) || commentsOf(formatted) !== commentsOf(text))
    throw new Error("resin could not format this document without changing it; please report it with the document");
  return { text: formatted, diagnostics: [] };
}

/** Tokens with resin's spacing: one space between words, none inside parentheses or around dots */
function join(tokens: Token[], text: (t: Token) => string): string {
  let s = "";
  let prev: Token | null = null;
  for (const t of tokens) {
    const tight =
      prev !== null &&
      (t.kind === "rparen" || t.kind === "comma" || t.kind === "dot" || t.kind === "question" || prev.kind === "lparen" || prev.kind === "dot" || (t.kind === "lparen" && prev.kind === "ident"));
    s += prev === null || tight ? text(t) : ` ${text(t)}`;
    prev = t;
  }
  return s;
}

const word = (t: Token | undefined, w: string): boolean => t?.kind === "ident" && !t.quoted && t.value === w;

/** A column line's name, type and modifiers, or null for a constraint line or a column whose type
 *  does not end on its first line */
function columnCells(ts: Token[], text: (t: Token) => string): ColumnCells | null {
  // A column is `name type ...`; a constraint, `unique(`, `index(` or `foreign(`, has `(` second
  if (ts.length < 2 || ts[0].kind !== "ident" || ts[1].kind !== "ident") return null;
  let i = 2;
  let type = text(ts[1]);
  if (ts[i]?.kind === "lparen") {
    const args: string[] = [];
    i++;
    while (i < ts.length && ts[i].kind !== "rparen") {
      if (ts[i].kind !== "comma") args.push(text(ts[i]));
      i++;
    }
    if (i >= ts.length) return null;
    i++;
    type += `(${args.join(",")})`;
  }
  if (ts[i]?.kind === "question") {
    type += "?";
    i++;
  }
  const modifiers: string[] = [];
  while (i < ts.length) {
    const start = i++;
    if ((word(ts[start], "uk") || word(ts[start], "index")) && word(ts[i], "as") && ts[i + 1]) i += 2;
    else if (word(ts[start], "enum") && ts[i]?.kind === "lparen") {
      let depth = 0;
      for (; i < ts.length; i++) {
        if (ts[i].kind === "lparen") depth++;
        else if (ts[i].kind === "rparen" && --depth === 0) {
          i++;
          break;
        }
      }
    } else if (ts[start].kind === "arrow" || ts[start].kind === "tildeArrow") {
      if (ts[i]?.kind === "ident") i++;
      while (ts[i]?.kind === "dot" && ts[i + 1]?.kind === "ident") i += 2;
    }
    modifiers.push(join(ts.slice(start, i), text));
  }
  return { name: text(ts[0]), type, modifiers };
}

/** The syntax tree without positions, to compare two documents */
function shape(doc: unknown): string {
  return JSON.stringify(doc, (key, value) => (key === "span" ? undefined : value));
}

/** A comment is what is left of a line after its last token */
function commentAfter(line: string, tokens: Token[]): string | null {
  const last = tokens.at(-1);
  const rest = line.slice(last ? last.span.col - 1 + last.span.len : 0).trim();
  return rest.startsWith("%%") ? rest : null;
}

/** Every comment in order, wherever it sits */
function commentsOf(text: string): string {
  const lines = text.split("\n");
  const onLine: Token[][] = lines.map(() => []);
  for (const t of lex(text).tokens) if (t.kind !== "newline" && t.kind !== "eof") onLine[t.span.line - 1].push(t);
  return lines.flatMap((l, i) => commentAfter(l, onLine[i]) ?? []).join("\n");
}
