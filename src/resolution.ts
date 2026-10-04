import type { Column, Document, Table } from "./ast.ts";

/** One analysis pass owns its index. Callers can still edit and recheck a parsed document. */
export class Resolution {
  readonly names = new Map<string, Table[]>();
  readonly columns = new Map<Table, Map<string, Column>>();
  readonly keys = new Map<Table, Column[]>();
  private scopes = new Map<string | null, Map<string, Table>>();
  private owners = new Map<Column, Table>();
  private refs = new Map<Column, { table: Table; column: Column } | null>();

  constructor(doc: Document) {
    for (const table of doc.tables) {
      const names = this.names.get(table.name.text) ?? [];
      names.push(table);
      this.names.set(table.name.text, names);
      const scope = table.service?.text ?? null;
      const scoped = this.scopes.get(scope) ?? new Map<string, Table>();
      if (!scoped.has(table.name.text)) scoped.set(table.name.text, table);
      this.scopes.set(scope, scoped);
      const columns = new Map<string, Column>();
      for (const column of table.columns) {
        if (!columns.has(column.name.text)) columns.set(column.name.text, column);
        this.owners.set(column, table);
      }
      this.columns.set(table, columns);
      this.keys.set(table, table.columns.filter(c => c.pk));
    }
  }

  table(name: string, owner: Table | undefined, service?: string | null): Table | null {
    const matches = this.names.get(name) ?? [];
    if (service != null) return this.scopes.get(service)?.get(name) ?? null;
    const local = this.scopes.get(owner?.service?.text ?? null)?.get(name);
    return local ?? (matches.length === 1 ? matches[0] : null);
  }

  ref(column: Column): { table: Table; column: Column } | null {
    if (!column.ref) return null;
    if (this.refs.has(column)) return this.refs.get(column)!;
    const ref = column.ref;
    const table = this.table(ref.table.text, this.owners.get(column), ref.service?.text);
    const keys = table ? this.keys.get(table)! : [];
    const target = table ? ref.column ? this.columns.get(table)!.get(ref.column.text) : keys.length === 1 ? keys[0] : null : null;
    const result = table && target ? { table, column: target } : null;
    this.refs.set(column, result);
    return result;
  }
}
