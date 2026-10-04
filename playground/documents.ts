import { DocumentStore, type DocumentWrite } from "./document-store.ts";
import { readState, type SharedState } from "./share.ts";

export const WORKSPACE_KEY = "resin.documents.v1";
const BACKEND_KEY = "resin.documents.backend";
export interface ImportRecord { sql: string; source: string; notes: { message: string; line: number; col: number }[] }
export interface SavedView { name: string; state: Omit<SharedState, "code" | "base"> }
export interface Revision { at: number; code: string; reason: string }
export interface LocalDocument {
  id: string;
  title: string;
  updated: number;
  state: SharedState;
  revisions: Revision[];
  views: SavedView[];
  imported: ImportRecord | null;
}
export interface Workspace { version: 1; active: string; documents: LocalDocument[] }
type StoragePort = Pick<Storage, "getItem" | "setItem">;
const clone = <T>(value: T): T => structuredClone(value);
const copyState = (state: SharedState): SharedState => ({ ...readState(state)!, ...(state.view ? { view: structuredClone(state.view) } : {}) });

/** A failed write never clears the last saved workspace. Work remains exportable in memory. */
export class Documents {
  private data: Workspace;
  private persisted: string | null = null;
  private readable = true;
  error: string | null = null;

  private backend: DocumentStore | null = null;
  private dirty = new Map<string, { history: boolean; imported: boolean }>();
  private writing: Promise<boolean> | null = null;
  private queued = false;
  private blocked = false;
  private backendMarked = false;
  pending = false;
  onChange: () => void = () => {};

  /** Existing localStorage data stays intact until an IndexedDB transaction has committed. */
  async connect(factory: IDBFactory): Promise<void> {
    let backend: DocumentStore;
    try { backend = await DocumentStore.open(factory); } catch {
      try {
        if (this.storage.getItem(BACKEND_KEY) === "indexeddb") {
          this.readable = false;
          this.error = "Saved documents are unavailable. Enable browser storage and reload; existing data has been kept.";
        }
      } catch { /* The synchronous fallback will report unavailable storage. */ }
      return;
    }
    try {
      const saved = await backend.load();
      if (saved) {
        const raw = JSON.stringify(saved);
        const checked = new Documents({ getItem: key => key === WORKSPACE_KEY ? raw : null, setItem: () => {} }, this.current().state);
        if (!checked.readable) throw new Error("Invalid saved documents");
        this.data = checked.data; this.readable = true; this.error = null;
      } else if (!this.readable) return;
      this.backend = backend;
      if (!saved) for (const d of this.data.documents) this.touch(d, true, true);
    } catch {
      this.readable = false;
      this.error = "Saved documents could not be read. Export this session before closing; the saved data has been kept.";
    }
  }
  get activeInfo(): Pick<LocalDocument, "id" | "title"> { const d = this.current(); return { id: d.id, title: d.title }; }
  private touch(d: LocalDocument, history = false, imported = false): void {
    const old = this.dirty.get(d.id);
    this.dirty.set(d.id, { history: history || old?.history === true, imported: imported || old?.imported === true });
  }
  async flush(): Promise<boolean> {
    if (!this.backend) return this.error === null;
    if (this.writing) return this.writing;
    if (!this.readable || this.blocked) return false;
    this.writing = (async () => {
      while (this.dirty.size) {
        const batch = this.dirty; this.dirty = new Map();
        // Copy only mutable containers; strings and unchanged history records are immutable.
        const writes: DocumentWrite[] = [...batch].map(([id, flags]) => {
          const d = this.data.documents.find(d => d.id === id)!;
          return { document: { ...d, state: copyState(d.state), views: structuredClone(d.views), revisions: flags.history ? d.revisions.slice() : [], imported: flags.imported ? d.imported : null }, ...flags };
        });
        try {
          await this.backend!.commit(this.data.active, this.data.documents.map(d => d.id), writes);
          if (!this.backendMarked) {
            try { this.storage.setItem(BACKEND_KEY, "indexeddb"); this.backendMarked = true; } catch { /* The committed document remains available in IndexedDB. */ }
          }
          this.error = null;
        }
        catch (error) {
          for (const [id, flags] of batch) { const current = this.dirty.get(id); this.dirty.set(id, { history: flags.history || current?.history === true, imported: flags.imported || current?.imported === true }); }
          this.error = error instanceof Error ? error.message : "Changes could not be saved in this browser. Download the .erd file before closing.";
          this.blocked = this.error.startsWith("Another tab");
          return false;
        }
      }
      return true;
    })();
    try { return await this.writing; }
    finally { this.writing = null; this.pending = false; this.onChange(); }
  }

  private storage: StoragePort;
  private now: () => number;
  private id: () => string;

  constructor(storage: StoragePort, initial: SharedState, now = () => Date.now(), id: () => string = () => crypto.randomUUID()) {
    this.storage = storage; this.now = now; this.id = id;
    this.data = { version: 1, active: "", documents: [] };
    try {
      this.persisted = storage.getItem(WORKSPACE_KEY);
      if (this.persisted) {
        const raw = JSON.parse(this.persisted);
        if (raw?.version !== 1 || !Array.isArray(raw.documents) || !raw.documents.length) throw new Error("Invalid workspace");
        const seen = new Set<string>();
        for (const d of raw.documents) {
          const state = readState(d.state);
          if (!state || typeof d.id !== "string" || seen.has(d.id) || typeof d.title !== "string") throw new Error("Invalid document");
          seen.add(d.id);
          this.data.documents.push({
            id: d.id, title: d.title, state, updated: Number(d.updated) || 0,
            revisions: Array.isArray(d.revisions) ? d.revisions.filter((r: Revision) => typeof r.code === "string" && typeof r.reason === "string" && Number.isFinite(r.at)).slice(-20) : [],
            views: Array.isArray(d.views) ? d.views.flatMap((v: SavedView) => {
              const checked = readState({ ...v.state, code: "" });
              return typeof v.name === "string" && checked ? [{ name: v.name, state: viewState(checked) }] : [];
            }) : [],
            imported: d.imported && typeof d.imported.sql === "string" && typeof d.imported.source === "string" && Array.isArray(d.imported.notes)
              ? { ...d.imported, notes: d.imported.notes.filter((n: ImportRecord["notes"][number]) => typeof n.message === "string" && Number.isInteger(n.line) && Number.isInteger(n.col)) } : null,
          });
        }
        this.data.active = seen.has(raw.active) ? raw.active : this.data.documents[0].id;
      }
    } catch {
      this.readable = false;
      this.error = "Saved documents could not be read. Export this session before closing; the saved data has been kept.";
      this.data = { version: 1, active: "", documents: [] };
    }
    if (!this.data.documents.length) {
      let state = initial;
      try { state = readState(JSON.parse(storage.getItem("resin.playground") ?? "null")) ?? initial; } catch { /* keep the initial document */ }
      const document = this.make("Untitled", state);
      this.data.documents.push(document);
      this.data.active = document.id;
    }
  }

  get active(): LocalDocument { return clone(this.data.documents.find(d => d.id === this.data.active)!); }
  list(): LocalDocument[] { return clone(this.data.documents).sort((a, b) => b.updated - a.updated); }
  private current(): LocalDocument { return this.data.documents.find(d => d.id === this.data.active)!; }
  private make(title: string, state: SharedState): LocalDocument {
    return { id: this.id(), title: title.trim() || "Untitled", updated: this.now(), state: copyState(state), revisions: [], views: [], imported: null };
  }
  private persist(): boolean {
    if (!this.readable || this.blocked) return false;
    if (this.backend) {
      this.pending = true;
      this.onChange();
      if (!this.queued) { this.queued = true; queueMicrotask(() => { this.queued = false; void this.flush(); }); }
      return true;
    }
    try {
      if (this.storage.getItem(WORKSPACE_KEY) !== this.persisted) {
        this.error = "Another tab changed the saved documents. Export this session, then reload to use the saved version.";
        return false;
      }
      const raw = JSON.stringify(this.data);
      this.storage.setItem(WORKSPACE_KEY, raw);
      this.persisted = raw;
      this.error = null;
      return true;
    } catch {
      this.error = "Changes could not be saved in this browser. Download the .erd file before closing.";
      return false;
    }
  }
  checkpoint(reason = "Before edit"): void {
    const d = this.current();
    if (d.revisions.at(-1)?.code !== d.state.code) {
      d.revisions.push({ at: Math.max(this.now(), (d.revisions.at(-1)?.at ?? 0) + 1), code: d.state.code, reason });
      d.revisions = d.revisions.slice(-20);
      this.touch(d, true);
    }
  }
  update(state: SharedState): boolean {
    const d = this.current();
    const next = copyState(state);
    const unchanged = d.state.code === next.code && d.state.base === next.base
      && JSON.stringify({ ...d.state, code: "", base: "" }) === JSON.stringify({ ...next, code: "", base: "" });
    if (this.backend && unchanged && !this.dirty.size) return this.error === null;
    if (d.state.code !== state.code && (!d.revisions.length || this.now() - d.revisions.at(-1)!.at >= 30_000)) this.checkpoint();
    d.state = next;
    this.touch(d);
    d.updated = this.now();
    return this.persist();
  }
  create(title: string, state: SharedState): LocalDocument {
    this.checkpoint("Before opening another document");
    const d = this.make(title, state);
    this.data.documents.push(d);
    this.touch(d, true, true);
    this.data.active = d.id;
    this.persist();
    return clone(d);
  }
  open(id: string): LocalDocument | null {
    if (!this.data.documents.some(d => d.id === id)) return null;
    this.checkpoint("Before opening another document");
    this.data.active = id;
    this.touch(this.current());
    this.persist();
    return this.active;
  }
  rename(title: string): void { this.current().title = title.trim() || "Untitled"; this.touch(this.current()); this.persist(); }
  restore(at: number): LocalDocument | null {
    const revision = this.current().revisions.find(r => r.at === at);
    if (!revision) return null;
    const code = revision.code;
    this.checkpoint("Before recovery");
    this.current().state.code = code;
    this.current().updated = this.now();
    this.touch(this.current());
    this.persist();
    return this.active;
  }
  imported(record: ImportRecord): void { this.current().imported = clone(record); this.touch(this.current(), false, true); this.persist(); }
  saveView(name: string, state: SharedState): void {
    const views = this.current().views;
    const v = { name: name.trim() || "Saved view", state: viewState(state) };
    const at = views.findIndex(x => x.name === v.name);
    if (at < 0) views.push(v); else views[at] = v;
    this.touch(this.current());
    this.persist();
  }
  backup(): string { return JSON.stringify(this.data, null, 2); }
}

function viewState({ code: _code, base: _base, ...state }: SharedState): SavedView["state"] { return clone(state); }
