import ELK from "elkjs/lib/elk-api.js";
import { toSvg, type ElkLike, type Model, type SvgOptions, type SvgResult } from "../src/index.ts";
declare const __RESIN_WORKER__: string;

/** ELK's supported worker API keeps graph layout off the editor thread. */
export class RenderClient {
  private elk: InstanceType<typeof ELK> | null = null;
  private worker: Worker | null = null;
  private workerURL: string | null = null;
  private ready: Promise<void> = Promise.resolve();
  private workerReady = false;
  private job: { reject: (reason: Error) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  private sequence = 0;
  private lastKey = "";
  private lastLayout: unknown = null;
  cancel(): void {
    if (!this.job) return;
    clearTimeout(this.job.timer);
    this.job.reject(new DOMException("Layout cancelled", "AbortError"));
    this.job = null;
    // Reuse a worker that is still loading. Terminating script initialization can crash Firefox.
    // No layout is sent until registration completes, so a cancelled request does no graph work.
    if (this.workerReady) { this.worker?.terminate(); this.worker = null; this.elk = null; this.releaseURL(); }
    this.sequence++;
  }
  render(model: Model, options: SvgOptions): Promise<SvgResult> {
    this.cancel();
    const id = ++this.sequence;
    if (!this.elk) {
      this.elk = new ELK({ workerFactory: () => {
        const url = URL.createObjectURL(new Blob([__RESIN_WORKER__], { type: "text/javascript" }));
        this.workerURL = url;
        this.workerReady = false;
        try {
          this.worker = new Worker(url);
          // WebKit may fetch a blob worker after the constructor returns.
          this.ready = new Promise(resolve => this.worker!.addEventListener("message", () => {
            if (this.workerURL === url) { this.workerReady = true; this.releaseURL(); }
            resolve();
          }, { once: true }));
          return this.worker;
        } catch (error) { this.releaseURL(); throw error; }
      } });
    }
    const elk = this.elk;
    const worker = this.worker!;
    const cached: ElkLike = { layout: async graph => {
      const key = JSON.stringify(graph);
      if (key === this.lastKey && this.lastLayout) return structuredClone(this.lastLayout) as typeof graph;
      await this.ready;
      if (id !== this.sequence) throw new DOMException("Layout cancelled", "AbortError");
      const result = await elk.layout(graph);
      if (id === this.sequence) { this.lastKey = key; this.lastLayout = structuredClone(result); }
      return result;
    } };
    return new Promise((resolve, reject) => {
      const finish = () => { if (this.job) clearTimeout(this.job.timer); this.job = null; };
      const fail = (message: string) => {
        if (id !== this.sequence) return;
        finish(); worker.terminate(); this.worker = null; this.elk = null; this.releaseURL(); reject(new Error(message));
      };
      this.job = { reject, timer: setTimeout(() => fail("Layout took too long. Try a related view or fewer tables, then retry."), 30_000) };
      worker.onerror = event => { console.error("resin layout worker:", event.message); event.preventDefault(); fail("The layout worker stopped. Retry to start a new worker."); };
      toSvg(model, cached, options).then(result => {
        if (id !== this.sequence) return;
        finish(); resolve(result);
      }, error => fail(error instanceof Error ? error.message : "Layout failed. Please retry."));
    });
  }
  private releaseURL(): void { if (this.workerURL) URL.revokeObjectURL(this.workerURL); this.workerURL = null; }
}
