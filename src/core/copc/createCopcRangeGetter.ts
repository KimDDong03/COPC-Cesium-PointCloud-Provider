import type { Getter } from "copc";
import { createCachedRangeGetter } from "./createCachedRangeGetter";
import {
  createHttpRangeGetter,
  type CopcHttpRangeGetterOptions,
} from "./createHttpRangeGetter";

export type CopcSourceInput = string | Blob;

export interface CopcSourceDescriptor {
  readonly key: string;
  readonly input: CopcSourceInput;
}

let blobSourceId = 0;

export function createCopcSourceDescriptor(
  input: CopcSourceInput,
): CopcSourceDescriptor {
  return {
    key: typeof input === "string" ? `url:${input}` : `blob:${++blobSourceId}`,
    input,
  };
}

export type CopcRangeGetterOptions = CopcHttpRangeGetterOptions;

const DEFAULT_MAX_RANGE_BYTE_LENGTH = 256 * 1024 * 1024;

export function createCopcRangeGetter(
  input: CopcSourceInput,
  options: CopcRangeGetterOptions = {},
): Getter {
  if (
    typeof input !== "string" &&
    typeof options.persistentRangeCache === "object" &&
    options.persistentRangeCache.enabled !== false
  ) {
    throw new Error(
      "Persistent COPC range caching is currently supported only for HTTP and HTTPS sources.",
    );
  }

  return typeof input === "string"
    ? createHttpRangeGetter(input, options)
    : createCachedRangeGetter(
        createBlobRangeGetter(
          input,
          readMaxRangeByteLength(options.maxRangeByteLength),
        ),
        options,
      );
}

export function createCopcSourceLabel(input: CopcSourceInput): string {
  if (typeof input === "string") {
    return input;
  }

  const namedBlob = input as Blob & { readonly name?: string };
  return namedBlob.name?.trim() || "COPC Blob";
}

function createBlobRangeGetter(
  blob: Blob,
  maxRangeByteLength: number,
): Getter {
  return async (begin: number, end: number): Promise<Uint8Array> => {
    if (
      !Number.isSafeInteger(begin) ||
      !Number.isSafeInteger(end) ||
      begin < 0 ||
      end < begin
    ) {
      throw new Error(`Invalid byte range: ${begin}-${end}`);
    }

    const byteLength = end - begin;

    if (byteLength > maxRangeByteLength) {
      throw new Error(
        `COPC byte range length ${byteLength} exceeds the configured maximum of ${maxRangeByteLength} bytes.`,
      );
    }

    if (end > blob.size) {
      throw new Error(
        `COPC Blob byte range ${begin}-${end} exceeds the source size of ${blob.size} bytes.`,
      );
    }

    if (byteLength === 0) {
      return new Uint8Array();
    }

    const arrayBuffer = await blob.slice(begin, end).arrayBuffer();
    const bytes = new Uint8Array(arrayBuffer);

    if (bytes.byteLength !== byteLength) {
      throw new Error(
        `COPC Blob range body length mismatch: expected ${byteLength} bytes, received ${bytes.byteLength}.`,
      );
    }

    return bytes;
  };
}

function readMaxRangeByteLength(value: number | undefined): number {
  const resolved = value ?? DEFAULT_MAX_RANGE_BYTE_LENGTH;

  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw new Error(
      `maxRangeByteLength must be a positive integer no greater than ${Number.MAX_SAFE_INTEGER}.`,
    );
  }

  return resolved;
}
