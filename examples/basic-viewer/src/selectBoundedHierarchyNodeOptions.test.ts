import { describe, expect, it } from "vitest";
import {
  resolveLoadedHierarchyNodeKey,
  selectBoundedHierarchyNodeOptions,
} from "./selectBoundedHierarchyNodeOptions";

describe("selectBoundedHierarchyNodeOptions", () => {
  const nodes = Array.from({ length: 1_000 }, (_, index) => ({
    key: `5-${index}-0-0`,
  }));

  it("caps the option list for large loaded hierarchies", () => {
    expect(
      selectBoundedHierarchyNodeOptions(nodes, {
        maxOptionCount: 64,
      }),
    ).toHaveLength(64);
  });

  it("keeps the preferred loaded node selectable outside the capped prefix", () => {
    const selectedNodes = selectBoundedHierarchyNodeOptions(nodes, {
      preferredNodeKey: "5-900-0-0",
      maxOptionCount: 64,
    });

    expect(selectedNodes[0]?.key).toBe("5-900-0-0");
    expect(selectedNodes).toHaveLength(64);
  });

  it("filters by typed node-key text before filling the bounded list", () => {
    expect(
      selectBoundedHierarchyNodeOptions(nodes, {
        query: "5-99",
        maxOptionCount: 10,
      }).map((node) => node.key),
    ).toEqual([
      "5-99-0-0",
      "5-990-0-0",
      "5-991-0-0",
      "5-992-0-0",
      "5-993-0-0",
      "5-994-0-0",
      "5-995-0-0",
      "5-996-0-0",
      "5-997-0-0",
      "5-998-0-0",
    ]);
  });

  it("uses an exact loaded typed key for direct entry", () => {
    expect(
      resolveLoadedHierarchyNodeKey(
        new Set(nodes.map((node) => node.key)),
        " 5-900-0-0 ",
        "5-0-0-0",
      ),
    ).toBe("5-900-0-0");
  });

  it("uses the selected match when typed text is only a filter", () => {
    expect(
      resolveLoadedHierarchyNodeKey(
        new Set(nodes.map((node) => node.key)),
        "5-99",
        "5-99-0-0",
      ),
    ).toBe("5-99-0-0");
  });

  it("rejects input when neither field identifies a loaded node", () => {
    expect(
      resolveLoadedHierarchyNodeKey(
        new Set(nodes.map((node) => node.key)),
        "missing",
        "also-missing",
      ),
    ).toBe("");
  });
});
