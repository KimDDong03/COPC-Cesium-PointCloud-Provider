import { describe, expect, it } from "vitest";
import type { PointGeometryBatch } from "copc-cesium";
import { createTerminalRenderInputHash } from "./createTerminalRenderInputHash";

describe("createTerminalRenderInputHash", () => {
  it("returns the same hash for the same geometry batches", () => {
    expect(createTerminalRenderInputHash(createGeometryBatches())).toBe(
      createTerminalRenderInputHash(createGeometryBatches()),
    );
  });

  it("changes when one coordinate changes", () => {
    const baseline = createGeometryBatches();
    const mutated = createGeometryBatches({
      mutateBatch: (batch) => {
        if (batch.key === "2-0-0-0:8000") {
          batch.positions[1] += 1;
        }
      },
    });

    expect(createTerminalRenderInputHash(mutated)).not.toBe(
      createTerminalRenderInputHash(baseline),
    );
  });

  it("changes when one color changes", () => {
    const baseline = createGeometryBatches();
    const mutated = createGeometryBatches({
      mutateBatch: (batch) => {
        if (batch.key === "2-0-0-0:8000") {
          batch.colors[2] += 1;
        }
      },
    });

    expect(createTerminalRenderInputHash(mutated)).not.toBe(
      createTerminalRenderInputHash(baseline),
    );
  });

  it("changes when batch order changes", () => {
    const baseline = createGeometryBatches();
    const reordered = createGeometryBatches({ reverseBatches: true });

    expect(createTerminalRenderInputHash(reordered)).not.toBe(
      createTerminalRenderInputHash(baseline),
    );
  });

  it("changes when batch key or density metadata changes", () => {
    const baseline = createGeometryBatches();
    const renamed = createGeometryBatches({
      mutateBatch: (batch) => {
        if (batch.key === "2-0-0-0:8000") {
          batch.key = "2-0-0-0:4000";
        }
      },
    });
    const densityChanged = createGeometryBatches({
      mutateBatch: (batch) => {
        if (batch.key === "2-0-0-0:8000") {
          batch.pointDensityScale = 0.25;
        }
      },
    });

    expect(createTerminalRenderInputHash(renamed)).not.toBe(
      createTerminalRenderInputHash(baseline),
    );
    expect(createTerminalRenderInputHash(densityChanged)).not.toBe(
      createTerminalRenderInputHash(baseline),
    );
  });
});

function createGeometryBatches(options?: {
  readonly mutateBatch?: (batch: MutablePointGeometryBatch) => void;
  readonly reverseBatches?: boolean;
}): PointGeometryBatch[] {
  const batches: MutablePointGeometryBatch[] = [
    {
      key: "2-0-0-0:8000",
      pointCount: 2,
      positions: new Float64Array([100, 200, 300, 101, 201, 301]),
      colors: new Uint8Array([10, 20, 30, 255, 11, 21, 31, 255]),
      pointSpacingMeters: 4,
      pointDensityScale: 0.5,
    },
    {
      key: "2-1-0-0:8000",
      pointCount: 1,
      positions: new Float64Array([110, 210, 310]),
      colors: new Uint8Array([12, 22, 32, 255]),
      pointSpacingMeters: 4,
      pointDensityScale: 0.5,
    },
  ];

  for (const batch of batches) {
    options?.mutateBatch?.(batch);
  }

  if (options?.reverseBatches) {
    batches.reverse();
  }

  return batches;
}

type MutablePointGeometryBatch = {
  -readonly [Key in keyof PointGeometryBatch]: PointGeometryBatch[Key];
};
