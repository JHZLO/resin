/** Bound both entry count and estimated retained bytes; large exports must not retain every view. */
export class LayoutCache<T> {
  private entries = new Map<string, { value: T; bytes: number }>();
  private bytes = 0;
  private maxEntries: number;
  private maxBytes: number;
  constructor(maxEntries = 6, maxBytes = 16 * 1024 * 1024) { this.maxEntries = maxEntries; this.maxBytes = maxBytes; }
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return structuredClone(entry.value);
  }
  set(key: string, value: T): void {
    const bytes = 2 * (key.length + JSON.stringify(value).length);
    const old = this.entries.get(key);
    if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value: structuredClone(value), bytes }); this.bytes += bytes;
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      const first = this.entries.keys().next().value!;
      this.bytes -= this.entries.get(first)!.bytes; this.entries.delete(first);
    }
  }
}
