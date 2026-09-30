// The playground editor: CodeMirror 6 with a small resin tokenizer and resin's diagnostics shown as
// lint marks. Diagnostics are pushed in by the app after every compile rather than pulled by a
// CodeMirror linter, because the app compiles on every change anyway.

import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, StreamLanguage, bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { type Diagnostic as CmDiagnostic, lintGutter, setDiagnostics } from "@codemirror/lint";
import { EditorState, type Text } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import type { Diagnostic } from "../src/index.ts";

const KEYWORDS = new Set(["table", "external", "pk", "uk", "enc", "enum", "index", "unique", "as", "audit"]);
/** Keywords that open a line where no column type follows */
const LINE_KEYWORDS = new Set(["table", "external", "unique", "index", "audit"]);

interface TokState {
  /** Identifiers seen on this line so far */
  idents: number;
  /** The line started with a keyword such as `table` */
  keywordLine: boolean;
}

const resin = StreamLanguage.define<TokState>({
  name: "resin",
  startState: () => ({ idents: 0, keywordLine: false }),
  token(stream, state) {
    if (stream.sol()) {
      state.idents = 0;
      state.keywordLine = false;
    }
    if (stream.eatSpace()) return null;
    if (stream.match("%%")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^`[^`]*`?/)) {
      state.idents++;
      return "variableName";
    }
    if (stream.match("->") || stream.match("~>")) return "operator";
    if (stream.match("?")) return "operator";
    if (stream.match(/^\d+/)) return "number";
    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) {
      const word = stream.current();
      const first = state.idents === 0;
      state.idents++;
      if (first && LINE_KEYWORDS.has(word)) state.keywordLine = true;
      // On a column line the second word is the type: `name type ...`
      if (!state.keywordLine && state.idents === 2) return "typeName";
      if (KEYWORDS.has(word)) return "keyword";
      return "variableName";
    }
    stream.next();
    return "punctuation";
  },
  languageData: { commentTokens: { line: "%%" } },
});

const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "var(--syn-kw)", fontWeight: "500" },
  { tag: t.typeName, color: "var(--syn-type)" },
  { tag: t.string, color: "var(--syn-str)" },
  { tag: t.number, color: "var(--syn-num)" },
  { tag: t.operator, color: "var(--accent)", fontWeight: "600" },
  { tag: t.comment, color: "var(--muted)", fontStyle: "italic" },
  { tag: t.punctuation, color: "var(--muted)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", fontSize: "13px", backgroundColor: "var(--panel)", color: "var(--ink)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.65" },
  ".cm-content": { caretColor: "var(--accent)", padding: "12px 0" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--faint)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "var(--active-line)", color: "var(--muted)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", color: "var(--ink)", border: "1px solid var(--rule)", borderRadius: "6px" },
  ".cm-diagnostic": { fontFamily: "var(--font-body)", fontSize: "12.5px", whiteSpace: "pre-wrap", padding: "6px 10px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--danger)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warn)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--danger)", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warn)", textUnderlineOffset: "3px" },
});

export interface Editor {
  view: EditorView;
  getText(): string;
  setText(text: string): void;
  showDiagnostics(ds: Diagnostic[]): void;
  focusAt(line: number, col: number): void;
}

export function createEditor(parent: HTMLElement, text: string, onChange: (text: string) => void): Editor {
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        highlightActiveLine(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        lintGutter(),
        resin,
        syntaxHighlighting(highlight),
        theme,
        EditorState.tabSize.of(2),
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap]),
        EditorView.contentAttributes.of({ "aria-label": "resin source" }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
        }),
      ],
    }),
  });

  return {
    view,
    getText: () => view.state.doc.toString(),
    setText(next) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: next } });
    },
    showDiagnostics(ds) {
      view.dispatch(setDiagnostics(view.state, ds.map((d) => toCm(view.state.doc, d))));
    },
    focusAt(line, col) {
      const l = view.state.doc.line(Math.min(Math.max(line, 1), view.state.doc.lines));
      const pos = Math.min(l.from + col - 1, l.to);
      view.dispatch({ selection: { anchor: pos }, scrollIntoView: true });
      view.focus();
    },
  };
}

/** A resin span (1-based line and column, UTF-16 length) as a CodeMirror range */
function toCm(doc: Text, d: Diagnostic): CmDiagnostic {
  const line = doc.line(Math.min(Math.max(d.span.line, 1), doc.lines));
  const from = Math.min(line.from + d.span.col - 1, line.to);
  const to = Math.min(from + Math.max(d.span.len, 1), line.to);
  return {
    from,
    to: Math.max(to, from),
    severity: d.severity,
    message: d.hint ? `${d.message}\nhint: ${d.hint}` : d.message,
  };
}
