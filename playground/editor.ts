// The playground editor: CodeMirror 6 with a small resin tokenizer and resin's diagnostics shown as
// lint marks. Diagnostics are pushed in by the app after every compile rather than pulled by a
// CodeMirror linter, because the app compiles on every change anyway.
//
// A paste can be converted on its way in (the app turns SQL into resin). The text goes in as pasted
// first and is converted in a second history step, so one undo brings back exactly what was pasted.

import { defaultKeymap, history, historyKeymap, indentWithTab, isolateHistory, undo } from "@codemirror/commands";
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
  placeholder,
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
  ".cm-scroller": { fontFamily: "var(--font-mono)", lineHeight: "1.7" },
  ".cm-content": { caretColor: "var(--accent)", padding: "12px 0 32px" },
  ".cm-line": { padding: "0 24px 0 8px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-gutters": { backgroundColor: "var(--panel)", color: "var(--faint)", border: "none", paddingLeft: "8px" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "26px", padding: "0 4px 0 0", fontSize: "12px" },
  // The current line shows only while the editor has focus, so an idle editor stays quiet
  ".cm-activeLine": { backgroundColor: "transparent" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
  "&.cm-focused .cm-activeLine": { backgroundColor: "var(--active-line)" },
  "&.cm-focused .cm-activeLineGutter": { color: "var(--ink)" },
  ".cm-placeholder": { color: "var(--faint)", fontStyle: "normal" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--accent-soft)", outline: "none", color: "inherit" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": { backgroundColor: "var(--selection) !important" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", color: "var(--ink)", border: "1px solid var(--rule)", borderRadius: "6px" },
  ".cm-diagnostic": { fontFamily: "var(--font-body)", fontSize: "12.5px", whiteSpace: "pre-wrap", padding: "6px 10px" },
  ".cm-diagnostic-error": { borderLeft: "3px solid var(--danger)" },
  ".cm-diagnostic-warning": { borderLeft: "3px solid var(--warn)" },
  ".cm-lintRange-error": { backgroundImage: "none", textDecoration: "underline wavy var(--danger)", textUnderlineOffset: "3px" },
  ".cm-lintRange-warning": { backgroundImage: "none", textDecoration: "underline wavy var(--warn)", textUnderlineOffset: "3px" },
  // Lint findings are advice: a dotted line in the warn color, and a dot in the gutter
  ".cm-diagnostic-info": { borderLeft: "3px solid var(--warn)" },
  ".cm-lintRange-info": { backgroundImage: "none", textDecoration: "underline dotted var(--warn)", textDecorationThickness: "1.5px", textUnderlineOffset: "4px" },
  ".cm-lint-marker-info": { content: "none", width: "6px", height: "6px", margin: "5px 4px", borderRadius: "50%", backgroundColor: "var(--warn)" },
});

export interface Editor {
  view: EditorView;
  getText(): string;
  setText(text: string): void;
  undo(): void;
  showDiagnostics(ds: Diagnostic[]): void;
  focusAt(line: number, col: number): void;
}

/** Shown in an empty editor */
function emptyHint(): HTMLElement {
  const el = document.createElement("span");
  el.style.whiteSpace = "pre";
  el.textContent = 'Start with a table:\n\ntable users "People who sign in" {\n  id     bigint        pk\n  email  varchar(255)  uk\n}\n\nOr paste SQL (CREATE TABLE ...) to convert it.';
  return el;
}

/** Turns pasted text into what goes in, or returns null to paste it as it is. `doc` is the document
 *  before the paste and `rest` the document without the selection the paste replaces. `whole` puts
 *  the text in place of the whole document instead of the selection. `applied` hears the document
 *  as a plain paste would have left it, and as it is after the conversion */
export type PasteConverter = (
  pasted: string,
  doc: string,
  rest: string,
) => { text: string; whole: boolean; applied?: (raw: string, converted: string) => void } | null;

export function createEditor(
  parent: HTMLElement,
  text: string,
  onChange: (text: string) => void,
  onCursor: (line: number, col: number) => void = () => {},
  convertPaste: PasteConverter = () => null,
): Editor {
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
        placeholder(emptyHint()),
        EditorView.domEventHandlers({
          paste(event, view) {
            const pasted = event.clipboardData?.getData("text/plain");
            if (!pasted) return false;
            const { from, to } = view.state.selection.main;
            const doc = view.state.doc;
            const converted = convertPaste(pasted, doc.toString(), doc.sliceString(0, from) + doc.sliceString(to));
            if (converted === null) return false;
            event.preventDefault();
            view.dispatch({ changes: { from, to, insert: pasted }, selection: { anchor: from + pasted.length }, userEvent: "input.paste" });
            const raw = view.state.doc.toString();
            const start = converted.whole ? 0 : from;
            const end = converted.whole ? view.state.doc.length : from + pasted.length;
            view.dispatch({
              changes: { from: start, to: end, insert: converted.text },
              selection: { anchor: converted.whole ? 0 : start + converted.text.length },
              annotations: isolateHistory.of("full"),
              scrollIntoView: true,
            });
            converted.applied?.(raw, view.state.doc.toString());
            return true;
          },
        }),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) onChange(u.state.doc.toString());
          if (u.docChanged || u.selectionSet) {
            const head = u.state.selection.main.head;
            const line = u.state.doc.lineAt(head);
            onCursor(line.number, head - line.from + 1);
          }
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
    undo() {
      undo(view);
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
    severity: d.rule ? "info" : d.severity,
    message: [d.message, d.hint && `hint: ${d.hint}`, d.rule && `lint: ${d.rule}`].filter(Boolean).join("\n"),
  };
}
