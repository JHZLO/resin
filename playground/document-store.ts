import type { LocalDocument, Workspace } from "./documents.ts";
export const DATABASE_NAME = "resin.documents";
interface Metadata { revision: number; active: string; ids: string[] }
export interface DocumentWrite { document: LocalDocument; history: boolean; imported: boolean }

/** Metadata and changed records commit atomically, including the conflict check. */
export class DocumentStore {
  private db: IDBDatabase;
  private revision = 0;
  private constructor(db: IDBDatabase) { this.db = db; db.onversionchange = () => db.close(); }
  static open(factory: IDBFactory): Promise<DocumentStore> {
    return new Promise((resolve, reject) => {
      const request = factory.open(DATABASE_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore("records");
      request.onsuccess = () => resolve(new DocumentStore(request.result));
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Document storage is busy"));
    });
  }
  load(): Promise<Workspace | null> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("records", "readonly");
      const store = transaction.objectStore("records");
      const request = store.get("workspace");
      let workspace: Workspace | null = null;
      request.onsuccess = () => {
        const meta = request.result as Metadata | undefined;
        if (!meta) return;
        if (!Number.isInteger(meta.revision) || !Array.isArray(meta.ids) || !meta.ids.length) { transaction.abort(); return; }
        this.revision = meta.revision;
        workspace = { version: 1, active: meta.active, documents: [] };
        for (const id of meta.ids) {
          const doc = store.get(`document:${id}`);
          const history = store.get(`history:${id}`);
          const imported = store.get(`import:${id}`);
          imported.onsuccess = () => workspace!.documents.push({ ...doc.result, revisions: history.result ?? [], imported: imported.result ?? null });
        }
      };
      transaction.oncomplete = () => resolve(workspace);
      transaction.onabort = () => reject(transaction.error ?? new Error("Invalid document storage"));
      transaction.onerror = () => {};
    });
  }
  commit(active: string, ids: string[], writes: DocumentWrite[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction("records", "readwrite");
      const store = transaction.objectStore("records");
      let conflict = false;
      const expected = this.revision;
      const request = store.get("workspace");
      request.onsuccess = () => {
        if ((request.result?.revision ?? 0) !== expected) { conflict = true; transaction.abort(); return; }
        try {
          for (const { document, history, imported } of writes) {
            const { revisions, imported: sql, ...record } = document;
            store.put(record, `document:${record.id}`);
            if (history) store.put(revisions, `history:${record.id}`);
            if (imported) store.put(sql, `import:${record.id}`);
          }
          store.put({ revision: expected + 1, active, ids } satisfies Metadata, "workspace");
        } catch { try { transaction.abort(); } catch { /* A failed request may already have aborted it. */ } }
      };
      transaction.oncomplete = () => { this.revision = expected + 1; resolve(); };
      transaction.onabort = () => reject(new Error(conflict ? "Another tab changed the saved documents. Export this session, then reload to use the saved version." : "Changes could not be saved in this browser. Download the .erd file before closing."));
      transaction.onerror = () => {};
    });
  }
}
