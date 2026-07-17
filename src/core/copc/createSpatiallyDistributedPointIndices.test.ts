import { describe, expect, it } from "vitest";
import { createSpatiallyDistributedPointIndices } from "./createSpatiallyDistributedPointIndices";

describe("createSpatiallyDistributedPointIndices", () => {
  it("is deterministic and gives every density the same nested prefix", () => {
    const points = Array.from({ length: 31 }, (_value, index) => ({
      x: (index * 17) % 31,
      y: (index * 11) % 29,
      z: (index * 7) % 23,
    }));
    const largest = createIndices(points, 13);

    expect(createIndices(points, 13)).toEqual(largest);

    for (const sampleCount of [1, 2, 3, 5, 8]) {
      expect(createIndices(points, sampleCount)).toEqual(
        largest.slice(0, sampleCount),
      );
    }

    expect(new Set(largest).size).toBe(largest.length);
    expect(largest.every((index) => index >= 0 && index < points.length)).toBe(
      true,
    );
  });

  it("covers a row-major grid better than index-stride sampling", () => {
    const points = Array.from({ length: 64 }, (_value, index) => ({
      x: index % 8,
      y: Math.floor(index / 8),
      z: 0,
    }));
    const spatialIndices = createIndices(points, 8);
    const strideIndices = Array.from({ length: 8 }, (_value, sampleIndex) =>
      Math.floor((sampleIndex * points.length) / 8),
    );

    expect(coverageRadiusSquared(points, spatialIndices)).toBeLessThan(
      coverageRadiusSquared(points, strideIndices),
    );
    expect(
      new Set(spatialIndices.map((pointIndex) => points[pointIndex]?.x)).size,
    ).toBeGreaterThan(
      new Set(strideIndices.map((pointIndex) => points[pointIndex]?.x)).size,
    );
  });

  it("keeps all indices in a strictly nested full-count order and handles empty input", () => {
    const points = Array.from({ length: 8 }, (_value, index) => ({
      x: index,
      y: 0,
      z: 0,
    }));
    const full = createIndices(points, points.length);

    expect(createIndices(points, 3)).toEqual(full.slice(0, 3));
    expect([...full].sort((first, second) => first - second)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7,
    ]);
    expect(full).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(
      createSpatiallyDistributedPointIndices({
        pointCount: 0,
        sampleCount: 10,
        getX: () => {
          throw new Error("empty input must not read coordinates");
        },
        getY: () => 0,
        getZ: () => 0,
      }),
    ).toEqual(new Uint32Array(0));
  });

  it("keeps coincident and non-finite points deterministic and unique", () => {
    const points = [
      { x: 1, y: 1, z: 1 },
      { x: 1, y: 1, z: 1 },
      { x: Number.NaN, y: 1, z: 1 },
      { x: Number.POSITIVE_INFINITY, y: 1, z: 1 },
      { x: 2, y: 2, z: 2 },
      { x: 2, y: 2, z: 2 },
    ];
    const first = createIndices(points, 5);
    const second = createIndices(points, 5);

    expect(second).toEqual(first);
    expect(new Set(first).size).toBe(5);
  });

  it("uses source index order as the stable tie-break for equal Morton codes", () => {
    const coincidentPoints = Array.from({ length: 8 }, () => ({
      x: 1,
      y: 1,
      z: 1,
    }));

    expect(createIndices(coincidentPoints, coincidentPoints.length)).toEqual([
      4, 0, 6, 2, 5, 1, 7, 3,
    ]);
  });

  it("honors aborts before and during spatial ordering", () => {
    const preAborted = new AbortController();
    preAborted.abort();

    expect(() =>
      createSpatiallyDistributedPointIndices({
        pointCount: 4,
        sampleCount: 2,
        getX: (index) => index,
        getY: (index) => index,
        getZ: (index) => index,
        signal: preAborted.signal,
      }),
    ).toThrow(expect.objectContaining({ name: "AbortError" }));

    const midSampleAbort = new AbortController();
    const abortReason = new Error("stop spatial sampling");

    expect(() =>
      createSpatiallyDistributedPointIndices({
        pointCount: 4_096,
        sampleCount: 32,
        getX: (index) => {
          if (index === 3) {
            midSampleAbort.abort(abortReason);
          }

          return index;
        },
        getY: (index) => index % 17,
        getZ: (index) => index % 31,
        signal: midSampleAbort.signal,
      }),
    ).toThrow(abortReason);
  });

  it("rejects invalid counts", () => {
    expect(() =>
      createSpatiallyDistributedPointIndices({
        pointCount: -1,
        sampleCount: 1,
        getX: () => 0,
        getY: () => 0,
        getZ: () => 0,
      }),
    ).toThrow("pointCount must be a non-negative safe integer.");

    expect(() =>
      createSpatiallyDistributedPointIndices({
        pointCount: 1,
        sampleCount: 0.5,
        getX: () => 0,
        getY: () => 0,
        getZ: () => 0,
      }),
    ).toThrow("sampleCount must be a non-negative safe integer.");
  });
});

function createIndices(
  points: readonly { readonly x: number; readonly y: number; readonly z: number }[],
  sampleCount: number,
): number[] {
  return Array.from(
    createSpatiallyDistributedPointIndices({
      pointCount: points.length,
      sampleCount,
      getX: (index) => points[index]?.x ?? 0,
      getY: (index) => points[index]?.y ?? 0,
      getZ: (index) => points[index]?.z ?? 0,
    }),
  );
}

function coverageRadiusSquared(
  points: readonly { readonly x: number; readonly y: number }[],
  selectedIndices: readonly number[],
): number {
  return points.reduce((largestDistance, point) => {
    const nearestDistance = selectedIndices.reduce(
      (smallestDistance, selectedIndex) => {
        const selectedPoint = points[selectedIndex];

        if (!selectedPoint) {
          return smallestDistance;
        }

        const xDistance = point.x - selectedPoint.x;
        const yDistance = point.y - selectedPoint.y;
        return Math.min(
          smallestDistance,
          xDistance * xDistance + yDistance * yDistance,
        );
      },
      Number.POSITIVE_INFINITY,
    );

    return Math.max(largestDistance, nearestDistance);
  }, 0);
}
