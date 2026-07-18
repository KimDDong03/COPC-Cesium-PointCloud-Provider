import { describe, expect, it } from "vitest";
import {
  createCopcRangeGetter,
  createCopcSourceDescriptor,
  createCopcSourceLabel,
} from "./createCopcRangeGetter";

describe("createCopcRangeGetter", () => {
  it("reads byte ranges directly from a Blob source", async () => {
    const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4, 5])]);
    const getter = createCopcRangeGetter(blob);

    await expect(getter(2, 5)).resolves.toEqual(new Uint8Array([2, 3, 4]));
    await expect(getter(3, 3)).resolves.toEqual(new Uint8Array());
  });

  it("caches repeated exact Blob byte range reads", async () => {
    class CountingBlob extends Blob {
      sliceCount = 0;

      override slice(start?: number, end?: number, contentType?: string): Blob {
        this.sliceCount += 1;
        return super.slice(start, end, contentType);
      }
    }

    const blob = new CountingBlob([new Uint8Array([0, 1, 2, 3, 4, 5])]);
    const getter = createCopcRangeGetter(blob);
    const first = await getter(2, 5);
    first[0] = 99;
    const second = await getter(2, 5);

    expect([...second]).toEqual([2, 3, 4]);
    expect(blob.sliceCount).toBe(1);
  });

  it("rejects Blob ranges that exceed the source size", async () => {
    const getter = createCopcRangeGetter(
      new Blob([new Uint8Array([0, 1, 2])]),
    );

    await expect(getter(2, 4)).rejects.toThrow(
      "COPC Blob byte range 2-4 exceeds the source size of 3 bytes.",
    );
  });

  it("rejects Blob ranges above the configured byte-length limit", async () => {
    const getter = createCopcRangeGetter(
      new Blob([new Uint8Array([0, 1, 2])]),
      { maxRangeByteLength: 2 },
    );

    await expect(getter(0, 3)).rejects.toThrow(
      "COPC byte range length 3 exceeds the configured maximum of 2 bytes.",
    );
  });

  it("rejects invalid Blob range-limit options at construction", () => {
    expect(() => createCopcRangeGetter(
      new Blob([new Uint8Array([0])]),
      { maxRangeByteLength: 0 },
    )).toThrow(
      "maxRangeByteLength must be a positive integer no greater than 9007199254740991.",
    );
  });

  it("rejects persistent range caching for Blob sources", () => {
    expect(() => createCopcRangeGetter(
      new Blob([new Uint8Array([0])]),
      {
        persistentRangeCache: {
          validation: {
            mode: "application-version",
            sourceByteLength: 1,
            version: "v1",
          },
        },
      },
    )).toThrow(
      "Persistent COPC range caching is currently supported only for HTTP and HTTPS sources.",
    );
  });

  it("rejects Blob slices that return a truncated body", async () => {
    class TruncatingBlob extends Blob {
      override slice(): Blob {
        return new Blob([new Uint8Array([9])]);
      }
    }

    const getter = createCopcRangeGetter(
      new TruncatingBlob([new Uint8Array([0, 1, 2, 3])]),
    );

    await expect(getter(1, 3)).rejects.toThrow(
      "COPC Blob range body length mismatch: expected 2 bytes, received 1.",
    );
  });

  it("creates stable URL keys and unique Blob keys", () => {
    const firstUrl = createCopcSourceDescriptor("https://example.com/a.copc.laz");
    const secondUrl = createCopcSourceDescriptor("https://example.com/a.copc.laz");
    const firstBlob = createCopcSourceDescriptor(new Blob([]));
    const secondBlob = createCopcSourceDescriptor(new Blob([]));

    expect(firstUrl.key).toBe(secondUrl.key);
    expect(firstBlob.key).not.toBe(secondBlob.key);
  });

  it("uses File-like Blob names as display labels", () => {
    const blob = new Blob([]) as Blob & { name: string };
    Object.defineProperty(blob, "name", {
      value: "sample.copc.laz",
    });

    expect(createCopcSourceLabel(blob)).toBe("sample.copc.laz");
  });
});
