import type { PointGeometryBatch } from "copc-cesium";

const HASH_VERSION = "terminal-render-geometry-input:v1";

type HashableTypedArray = Float64Array | Uint8Array;

export function createTerminalRenderInputHash(
  batches: readonly PointGeometryBatch[],
): string {
  const hash = createDual32Hash();

  hash.addString(HASH_VERSION);
  hash.addFloat64(batches.length);

  for (const batch of batches) {
    hash.addString(batch.key);
    hash.addFloat64(batch.pointCount);
    hash.addOptionalFloat64(batch.pointSpacingMeters);
    hash.addOptionalFloat64(batch.pointDensityScale);
    hash.addTypedArray(batch.positions);
    hash.addTypedArray(batch.colors);
  }

  return hash.digest();
}

function createDual32Hash(): {
  readonly addFloat64: (value: number) => void;
  readonly addOptionalFloat64: (value: number | undefined) => void;
  readonly addString: (value: string) => void;
  readonly addTypedArray: (value: HashableTypedArray) => void;
  readonly addUint32: (value: number) => void;
  readonly digest: () => string;
} {
  let left = 0x811c9dc5;
  let right = 0x27d4eb2d;
  const scratch = new ArrayBuffer(8);
  const scratchView = new DataView(scratch);
  const scratchBytes = new Uint8Array(scratch);
  const encoder = new TextEncoder();

  function mixByte(byte: number): void {
    left = Math.imul(left ^ byte, 0x01000193) >>> 0;
    right = (Math.imul(right ^ byte, 0x85ebca6b) + 0x9e3779b9) >>> 0;
  }

  function addBytes(bytes: Uint8Array): void {
    const alignedLength = bytes.byteLength - (bytes.byteLength % 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

    for (let offset = 0; offset < alignedLength; offset += 4) {
      const chunk = view.getUint32(offset, true);
      left = Math.imul(left ^ chunk, 0x01000193) >>> 0;
      right = (Math.imul(right ^ chunk, 0x85ebca6b) + 0x9e3779b9) >>> 0;
    }

    for (let offset = alignedLength; offset < bytes.byteLength; offset += 1) {
      mixByte(bytes[offset]);
    }
  }

  function addUint32(value: number): void {
    scratchView.setUint32(0, value >>> 0, true);
    addBytes(scratchBytes.subarray(0, 4));
  }

  function addFloat64(value: number): void {
    scratchView.setFloat64(0, value, true);
    addBytes(scratchBytes);
  }

  function addOptionalFloat64(value: number | undefined): void {
    if (value === undefined) {
      addUint32(0);
      return;
    }

    addUint32(1);
    addFloat64(value);
  }

  function addString(value: string): void {
    const bytes = encoder.encode(value);
    addUint32(bytes.byteLength);
    addBytes(bytes);
  }

  function addTypedArray(value: HashableTypedArray): void {
    addString(value.constructor.name);
    addUint32(value.length);
    addBytes(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
  }

  return {
    addFloat64,
    addOptionalFloat64,
    addString,
    addTypedArray,
    addUint32,
    digest: () =>
      `${left.toString(16).padStart(8, "0")}${right
        .toString(16)
        .padStart(8, "0")}`,
  };
}
