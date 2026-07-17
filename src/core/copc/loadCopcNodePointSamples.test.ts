import { describe, expect, it } from "vitest";
import {
  sampleCopcPointDataView,
  type CopcPointDataView,
} from "./loadCopcNodePointSamples";

describe("sampleCopcPointDataView", () => {
  it("samples positions and normalizes 16-bit colors from a decoded point view", () => {
    const view = createPointDataView({
      X: [10, 20, 30, 40],
      Y: [1, 2, 3, 4],
      Z: [100, 200, 300, 400],
      Red: [0, 65_535, 32_768, 257],
      Green: [257, 32_768, 65_535, 0],
      Blue: [65_535, 257, 0, 32_768],
      Classification: [2, 6, 9, 5],
      Intensity: [0, 65_535, 32_768, 257],
    });

    const result = sampleCopcPointDataView({
      nodeKey: "1-0-0-0",
      view,
      maxPointCount: 2,
    });

    expect(result).toEqual({
      nodeKey: "1-0-0-0",
      nodePointCount: 4,
      sampledPointCount: 2,
      points: [
        {
          x: 30,
          y: 3,
          z: 300,
          color: {
            red: 128,
            green: 255,
            blue: 0,
          },
          classification: 9,
          intensity: 32_768,
        },
        {
          x: 10,
          y: 1,
          z: 100,
          color: {
            red: 0,
            green: 1,
            blue: 255,
          },
          classification: 2,
          intensity: 0,
        },
      ],
    });
  });

  it("can sample positions and colors into typed arrays", () => {
    const view = createPointDataView({
      X: [10, 20, 30, 40],
      Y: [1, 2, 3, 4],
      Z: [100, 200, 300, 400],
      Red: [0, 65_535, 32_768, 257],
      Green: [257, 32_768, 65_535, 0],
      Blue: [65_535, 257, 0, 32_768],
      Classification: [2, 6, 9, 5],
      Intensity: [0, 65_535, 32_768, 257],
    });

    const result = sampleCopcPointDataView({
      nodeKey: "1-0-0-0",
      view,
      maxPointCount: 2,
      sampleFormat: "typed",
    });

    expect(result.points).toEqual([]);
    expect(result.pointData?.x).toEqual(new Float64Array([30, 10]));
    expect(result.pointData?.y).toEqual(new Float64Array([3, 1]));
    expect(result.pointData?.z).toEqual(new Float64Array([300, 100]));
    expect(result.pointData?.red).toEqual(new Uint8Array([128, 0]));
    expect(result.pointData?.green).toEqual(new Uint8Array([255, 1]));
    expect(result.pointData?.blue).toEqual(new Uint8Array([0, 255]));
    expect(result.pointData?.classification).toEqual(new Uint8Array([9, 2]));
    expect(result.pointData?.intensity).toEqual(
      new Uint16Array([32_768, 0]),
    );
  });

  it("keeps classification and intensity when RGB dimensions are absent", () => {
    const view = createPointDataView({
      X: [10, 20],
      Y: [1, 2],
      Z: [100, 200],
      Classification: [6, 9],
      Intensity: [12_345, 54_321],
    });

    const result = sampleCopcPointDataView({
      nodeKey: "1-0-0-0",
      view,
      maxPointCount: 2,
      sampleFormat: "typed",
    });

    expect(result.pointData?.red).toBeUndefined();
    expect(result.pointData?.green).toBeUndefined();
    expect(result.pointData?.blue).toBeUndefined();
    expect(result.pointData?.classification).toEqual(new Uint8Array([9, 6]));
    expect(result.pointData?.intensity).toEqual(
      new Uint16Array([54_321, 12_345]),
    );
  });

  it("clamps classification and intensity to their LAS unsigned ranges", () => {
    const view = createPointDataView({
      X: [10, 20, 30],
      Y: [1, 2, 3],
      Z: [100, 200, 300],
      Classification: [-1, 12.6, 300],
      Intensity: [-1, 32_768.4, 70_000],
    });

    const result = sampleCopcPointDataView({
      nodeKey: "1-0-0-0",
      view,
      maxPointCount: 3,
      sampleFormat: "typed",
    });

    expect(result.pointData?.classification).toEqual(
      new Uint8Array([255, 0, 13]),
    );
    expect(result.pointData?.intensity).toEqual(
      new Uint16Array([65_535, 0, 32_768]),
    );
  });

  it("keeps lower-density samples as deterministic prefixes", () => {
    const view = createPointDataView({
      X: Array.from({ length: 24 }, (_value, index) => (index * 7) % 24),
      Y: Array.from({ length: 24 }, (_value, index) => (index * 11) % 23),
      Z: Array.from({ length: 24 }, (_value, index) => (index * 5) % 19),
    });
    const dense = sampleCopcPointDataView({
      nodeKey: "2-1-0-1",
      view,
      maxPointCount: 13,
    });

    for (const maxPointCount of [1, 3, 7, 9]) {
      const sparse = sampleCopcPointDataView({
        nodeKey: "2-1-0-1",
        view,
        maxPointCount,
      });

      expect(sparse.points).toEqual(dense.points.slice(0, maxPointCount));
    }

    expect(
      sampleCopcPointDataView({
        nodeKey: "2-1-0-1",
        view,
        maxPointCount: 13,
      }).points,
    ).toEqual(dense.points);
  });

  it("reuses a supplied density-independent spatial order without rebuilding it", () => {
    const baseView = createPointDataView({
      X: [0, 1, 2, 3, 4, 5],
      Y: [10, 11, 12, 13, 14, 15],
      Z: [20, 21, 22, 23, 24, 25],
      Classification: [30, 31, 32, 33, 34, 35],
    });
    const getterCallCounts = new Map<string, number>();
    const view: CopcPointDataView = {
      ...baseView,
      getter: (name) => {
        const getValue = baseView.getter(name);

        return (index) => {
          getterCallCounts.set(name, (getterCallCounts.get(name) ?? 0) + 1);
          return getValue(index);
        };
      },
    };
    const spatialPointOrder = new Uint32Array([5, 1, 4, 0, 3, 2]);
    const result = sampleCopcPointDataView({
      nodeKey: "2-1-0-1",
      view,
      maxPointCount: 3,
      sampleFormat: "typed",
      spatialPointOrder,
    });

    expect(result.pointData?.x).toEqual(new Float64Array([5, 1, 4]));
    expect(result.pointData?.y).toEqual(new Float64Array([15, 11, 14]));
    expect(result.pointData?.classification).toEqual(
      new Uint8Array([35, 31, 34]),
    );
    expect(getterCallCounts).toEqual(
      new Map([
        ["X", 3],
        ["Y", 3],
        ["Z", 3],
        ["Classification", 3],
      ]),
    );
    expect(spatialPointOrder.buffer.byteLength).toBe(24);
  });

  it("rejects malformed supplied spatial orders", () => {
    const view = createPointDataView({
      X: [0, 1, 2],
      Y: [0, 1, 2],
      Z: [0, 1, 2],
    });

    expect(() =>
      sampleCopcPointDataView({
        nodeKey: "1-0-0-0",
        view,
        maxPointCount: 2,
        spatialPointOrder: new Uint32Array([0, 1]),
      }),
    ).toThrow("spatialPointOrder length must match view.pointCount.");

    expect(() =>
      sampleCopcPointDataView({
        nodeKey: "1-0-0-0",
        view,
        maxPointCount: 2,
        spatialPointOrder: new Uint32Array([3, 1, 0]),
      }),
    ).toThrow("spatialPointOrder contains an invalid point index.");
  });

  it("keeps every typed attribute aligned after spatial reordering", () => {
    const sourceIndices = Array.from({ length: 16 }, (_value, index) => index);
    const view = createPointDataView({
      X: sourceIndices,
      Y: sourceIndices.map((index) => 1_000 + index),
      Z: sourceIndices.map((index) => 2_000 - index),
      Red: sourceIndices.map((index) => index * 257),
      Green: sourceIndices.map((index) => (100 + index) * 257),
      Blue: sourceIndices.map((index) => (200 + index) * 257),
      Classification: sourceIndices.map((index) => 20 + index),
      Intensity: sourceIndices.map((index) => 10_000 + index),
    });
    const result = sampleCopcPointDataView({
      nodeKey: "2-1-0-1",
      view,
      maxPointCount: 7,
      sampleFormat: "typed",
    });
    const pointData = result.pointData;

    expect(pointData).toBeDefined();

    for (let sampleIndex = 0; sampleIndex < 7; sampleIndex += 1) {
      const sourceIndex = pointData?.x[sampleIndex] ?? -1;

      expect(pointData?.y[sampleIndex]).toBe(1_000 + sourceIndex);
      expect(pointData?.z[sampleIndex]).toBe(2_000 - sourceIndex);
      expect(pointData?.red?.[sampleIndex]).toBe(sourceIndex);
      expect(pointData?.green?.[sampleIndex]).toBe(100 + sourceIndex);
      expect(pointData?.blue?.[sampleIndex]).toBe(200 + sourceIndex);
      expect(pointData?.classification?.[sampleIndex]).toBe(20 + sourceIndex);
      expect(pointData?.intensity?.[sampleIndex]).toBe(10_000 + sourceIndex);
    }
  });

  it("keeps every decoded point while preserving strict full-count nesting", () => {
    const view = createPointDataView({
      X: [0, 1, 2, 3, 4, 5, 6, 7],
      Y: [0, 0, 0, 0, 0, 0, 0, 0],
      Z: [0, 0, 0, 0, 0, 0, 0, 0],
      Classification: [10, 11, 12, 13, 14, 15, 16, 17],
    });
    const full = sampleCopcPointDataView({
      nodeKey: "1-0-0-0",
      view,
      maxPointCount: 10,
    });
    const sparse = sampleCopcPointDataView({
      nodeKey: "1-0-0-0",
      view,
      maxPointCount: 3,
    });

    expect(sparse.points).toEqual(full.points.slice(0, 3));
    expect(full.points.map(({ x }) => x).sort((a, b) => a - b)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);

    for (const point of full.points) {
      expect(point.classification).toBe(10 + point.x);
    }
  });

  it("returns an aligned empty typed result for a zero budget", () => {
    const view = createPointDataView({
      X: [],
      Y: [],
      Z: [],
      Red: [],
      Green: [],
      Blue: [],
      Classification: [],
      Intensity: [],
    });
    const result = sampleCopcPointDataView({
      nodeKey: "0-0-0-0",
      view,
      maxPointCount: 0,
      sampleFormat: "typed",
    });

    expect(result).toMatchObject({
      nodePointCount: 0,
      sampledPointCount: 0,
      points: [],
    });
    expect(result.pointData?.x).toEqual(new Float64Array(0));
    expect(result.pointData?.red).toEqual(new Uint8Array(0));
    expect(result.pointData?.classification).toEqual(new Uint8Array(0));
    expect(result.pointData?.intensity).toEqual(new Uint16Array(0));
  });

  it("propagates an abort raised while spatially ordering a decoded view", () => {
    const controller = new AbortController();
    const reason = new Error("stop decoded point sampling");
    const pointCount = 4_096;
    const view: CopcPointDataView = {
      pointCount,
      dimensions: { X: {}, Y: {}, Z: {} },
      getter: (name) => (index) => {
        if (name === "X" && index === 3) {
          controller.abort(reason);
        }

        return index;
      },
    };

    expect(() =>
      sampleCopcPointDataView({
        nodeKey: "1-0-0-0",
        view,
        maxPointCount: 32,
        signal: controller.signal,
      }),
    ).toThrow(reason);
  });
});

function createPointDataView(
  dimensions: Record<string, readonly number[]>,
): CopcPointDataView {
  const pointCount = Object.values(dimensions)[0]?.length ?? 0;

  return {
    pointCount,
    dimensions,
    getter: (name) => {
      const values = dimensions[name];

      if (!values) {
        throw new Error(`No test dimension: ${name}`);
      }

      return (index) => {
        const value = values[index];

        if (value === undefined) {
          throw new Error(`No test value at ${index} for ${name}`);
        }

        return value;
      };
    },
  };
}
