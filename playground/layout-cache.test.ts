import { describe, expect, it } from "vitest";
import { LayoutCache } from "./layout-cache.ts";
describe("layout cache", () => {
  it("keeps recent views, evicts the oldest, and isolates callers' mutations", () => {
    const cache = new LayoutCache<{ x: number }>(2);
    cache.set("all", { x: 1 }); cache.set("names", { x: 2 });
    const first = cache.get("all")!; first.x = 99;
    cache.set("related", { x: 3 });
    expect(cache.get("names")).toBeUndefined();
    expect(cache.get("all")).toEqual({ x: 1 });
    expect(cache.get("related")).toEqual({ x: 3 });
  });
  it("bounds retained bytes, including keys and replacement entries", () => {
    const cache = new LayoutCache<string>(5, 32);
    cache.set("a", "123456"); cache.set("b", "123456");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("123456");
    cache.set("b", "x".repeat(32));
    expect(cache.get("b")).toBeUndefined();
    cache.set("c", "ok"); expect(cache.get("c")).toBe("ok");
  });
});
