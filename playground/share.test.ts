import { describe, expect, it } from "vitest";
import { decode, encode, readState } from "./share.ts";

describe("saved and shared documents", () => {
  it("rejects malformed document fields instead of starting a broken editor", () => {
    for (const value of [null, [], 1, "text", {}, { code: 42 }]) expect(readState(value)).toBeNull();
    expect(readState({ code: "", columns: "bad", audit: null, related: { table: 12 }, base: 17 })).toEqual({
      code: "", columns: "all", audit: "collapse", edges: "angular", related: null, base: null,
    });
  });

  it("round trips Unicode, an empty comparison base and the complete shared view", async () => {
    const state = { code: "table `주문` { id int pk }", columns: "keys", audit: "expand", edges: "curved", related: { table: "주문", steps: 2 }, base: "" } as const;
    expect(await decode(await encode(state))).toEqual(state);
  });

  it("keeps the Services level and one service's view, but not both views of a part", async () => {
    const state = { code: "service s { table a { id int pk } }", columns: "services", audit: "collapse", edges: "angular", related: null, service: "s", base: null } as const;
    expect(await decode(await encode(state))).toEqual(state);
    expect(readState({ code: "", service: "s", related: { table: "a", steps: 1 } })).not.toHaveProperty("service");
  });

  it("opens older code-only links with valid defaults", () => {
    expect(readState({ code: "table a { id int pk }" })).toMatchObject({ columns: "all", related: null, base: null });
  });

  it("ignores damaged and unrelated hashes", async () => {
    for (const hash of ["", "#section", "#erd:!", "#erd:AA", "#erd:e30"]) expect(await decode(hash)).toBeNull();
  });
});
