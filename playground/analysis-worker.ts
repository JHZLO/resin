import { Analyzer } from "./analysis.ts";
const analyzer = new Analyzer();
self.onmessage = (event: MessageEvent<{ id: number; code: string; base: string | null }>) => {
  const { id, code, base } = event.data;
  try { self.postMessage({ id, result: analyzer.analyze(code, base) }); }
  catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : "Source analysis failed" }); }
};
self.postMessage({ ready: true });
