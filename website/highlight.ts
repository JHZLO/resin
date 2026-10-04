// resin source to highlighted HTML, for the site's code blocks. The rules are the playground editor's
// (playground/editor.ts), so code reads the same on every page.

const KEYWORDS = new Set(["group", "table", "external", "pk", "uk", "enc", "enum", "index", "unique", "as", "audit"]);
/** Keywords that open a line where no column type follows */
const LINE_KEYWORDS = new Set(["group", "table", "external", "unique", "index", "audit"]);

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const span = (cls: string, text: string): string => `<span class="${cls}">${esc(text)}</span>`;

export function highlightResin(source: string): string {
  return source
    .replace(/\n$/, "")
    .split("\n")
    .map((line) => {
      let i = 0;
      let idents = 0;
      let keywordLine = false;
      let out = "";
      while (i < line.length) {
        const rest = line.slice(i);
        let m: RegExpMatchArray | null;
        if ((m = rest.match(/^[ \t]+/))) {
          out += m[0];
        } else if (rest.startsWith("%%")) {
          out += span("c", rest);
          break;
        } else if ((m = rest.match(/^"(?:[^"\\]|\\.)*"?/))) {
          out += span("s", m[0]);
        } else if ((m = rest.match(/^`[^`]*`?/))) {
          idents++;
          out += esc(m[0]);
        } else if (rest.startsWith("->") || rest.startsWith("~>")) {
          m = [rest.slice(0, 2)] as RegExpMatchArray;
          out += span("o", m[0]);
        } else if (rest.startsWith("?")) {
          m = ["?"] as RegExpMatchArray;
          out += span("o", "?");
        } else if ((m = rest.match(/^\d+/))) {
          out += span("n", m[0]);
        } else if ((m = rest.match(/^[A-Za-z_][A-Za-z0-9_]*/))) {
          const word = m[0];
          const first = idents === 0;
          idents++;
          if (first && LINE_KEYWORDS.has(word)) keywordLine = true;
          // On a column line the second word is the type: `name type ...`
          if (!keywordLine && idents === 2) out += span("t", word);
          else if (KEYWORDS.has(word)) out += span("k", word);
          else out += esc(word);
        } else {
          m = [rest[0]] as RegExpMatchArray;
          out += span("p", m[0]);
        }
        i += m[0].length;
      }
      return out;
    })
    .join("\n");
}
