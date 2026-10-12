import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { glassOf, stageOf } from "../src/svg.ts";
import { LiveGlass } from "./glass.ts";

class MotionPreference extends EventTarget { matches = false; }
class Canvas extends EventTarget {
  style = { cssText: "" };
  className = "";
  hidden = false;
  width = 0;
  height = 0;
  setAttribute() {}
  getContext() { return gl; }
}

let gl: WebGL2RenderingContext;
let calls: Map<string, ReturnType<typeof vi.fn>>;
let canvas: Canvas;
let preference: MotionPreference;
let frames: Map<number, FrameRequestCallback>;
let nextFrame = 0;
beforeEach(() => {
  calls = new Map();
  let resource = 0;
  gl = new Proxy({} as WebGL2RenderingContext, {
    get(_target, prop) {
      const name = String(prop);
      if (/^[A-Z0-9_]+$/.test(name)) return name;
      if (!calls.has(name)) calls.set(name, vi.fn((...args: unknown[]) => {
        if (name === "getShaderParameter" || name === "getProgramParameter") return true;
        if (name === "isContextLost") return false;
        if (name === "getUniformLocation") return args[1];
        if (name.startsWith("create")) return { resource: ++resource };
        return undefined;
      }));
      return calls.get(name);
    },
  });
  canvas = new Canvas();
  preference = new MotionPreference();
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("document", { createElement: () => canvas });
  vi.stubGlobal("window", { devicePixelRatio: 2 });
  vi.stubGlobal("matchMedia", () => preference);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("ResizeObserver", class { observe() {} });
});
afterEach(() => vi.unstubAllGlobals());

function setup() {
  const viewport = Object.assign(new EventTarget(), {
    clientWidth: 1000, clientHeight: 800,
    insertBefore: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
  });
  const glass = new LiveGlass(viewport as unknown as HTMLElement, {} as HTMLElement);
  glass.setLook(stageOf("aurora-dark"), glassOf("aurora-dark"));
  return glass;
}

function frame(time: number): void {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(time);
}

describe("LiveGlass recovery", () => {
  it("allocates the restored render texture before drawing, without requiring a resize", () => {
    const glass = setup();
    glass.setBoxes([{ table: "orders", x: 20, y: 30, w: 200, h: 140 }], null);
    glass.setView(0.5, 60, 70);
    const allocated = calls.get("texImage2D")!;
    expect(allocated).toHaveBeenCalledTimes(1);
    const lost = new Event("webglcontextlost", { cancelable: true });
    canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(frames.size).toBe(0);
    canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(allocated).toHaveBeenCalledTimes(2);
    expect(allocated.mock.calls[1].slice(3, 5)).toEqual([500, 400]);
    frame(100);
    expect(calls.get("uniform3f")).toHaveBeenCalledWith("uView", 60, 70, 0.5);
    expect(calls.get("drawArraysInstanced")).toHaveBeenCalledWith("TRIANGLE_STRIP", 0, 4, 1);
  });

  it("draws every requested frame with reduced motion, even after a long idle", () => {
    preference.matches = true;
    const glass = setup();
    frame(5000);
    expect(calls.get("drawArrays")?.mock.calls.length ?? 0).toBe(2);
    expect(frames.size).toBe(0);
    glass.setGrid(false);
    frame(6000);
    expect(calls.get("drawArrays")).toHaveBeenCalledTimes(4);
    expect(calls.get("uniform4fv")).toHaveBeenCalledWith("uGrid", [0, 0, 0, 0]);
    expect(frames.size).toBe(0);
  });

  it("resumes the stage when reduced motion is switched off", () => {
    preference.matches = true;
    setup();
    frame(100);
    expect(frames.size).toBe(0);
    preference.matches = false;
    preference.dispatchEvent(new Event("change"));
    expect(frames.size).toBe(1);
    frame(200);
    expect(frames.size).toBe(1);
  });

  it("cancels scheduled frames while paused and resumes without losing its view", () => {
    const glass = setup();
    glass.setView(0.75, 40, 50);
    glass.pause(true);
    expect(frames.size).toBe(0);
    glass.setGrid(false);
    expect(frames.size).toBe(0);
    glass.pause(false);
    expect(frames.size).toBe(1);
    frame(100);
    expect(calls.get("uniform3f")).toHaveBeenCalledWith("uView", 40, 50, 0.75);
  });
});
