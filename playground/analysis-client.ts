import type { Analysis } from "./analysis.ts";
declare const __RESIN_ANALYSIS_WORKER__: string;

export class AnalysisClient {
  private worker: Worker | null = null;
  private url: string | null = null;
  private sequence = 0;
  private generation = 0;
  private current: { id: number; resolve: (value: Analysis) => void; reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private cached: { code: string; base: string | null; value: Analysis } | null = null;
  cancel(): void {
    if (this.current) { clearTimeout(this.current.timer); this.current.reject(new DOMException("Analysis cancelled", "AbortError")); this.current = null; }
  }
  analyze(code: string, base: string | null): Promise<Analysis> {
    this.cancel();
    if (this.cached?.code === code && this.cached.base === base) return Promise.resolve(this.cached.value);
    if (!this.worker) {
      this.generation++;
      this.url = URL.createObjectURL(new Blob([__RESIN_ANALYSIS_WORKER__], { type: "text/javascript" }));
      try { this.worker = new Worker(this.url); } catch (error) { this.release(); throw error; }
      this.worker.onmessage = event => {
        this.release();
        const pending = this.current;
        if (!pending || event.data.id !== pending.id) return;
        clearTimeout(pending.timer); this.current = null;
        if (event.data.error) pending.reject(new Error(event.data.error));
        else pending.resolve(event.data.result);
      };
      this.worker.onerror = event => { event.preventDefault(); this.fail("Source analysis stopped. Retry when ready."); };
    }
    const id = ++this.sequence;
    return new Promise<Analysis>((resolve, reject) => {
      this.current = { id, resolve, reject, timer: setTimeout(() => this.fail("Source analysis took too long. Retry with a smaller document."), 30_000) };
      this.worker!.postMessage({ id, code, base });
    }).then(value => {
      // A restarted worker has an independent version counter.
      const result = { ...value, modelKey: this.generation * 1_000_000_000 + value.modelKey };
      this.cached = { code, base, value: result };
      return result;
    });
  }
  private fail(message: string): void {
    if (this.current) { clearTimeout(this.current.timer); this.current.reject(new Error(message)); this.current = null; }
    this.worker?.terminate(); this.worker = null; this.release(); this.cached = null;
  }
  private release(): void { if (this.url) URL.revokeObjectURL(this.url); this.url = null; }
}
