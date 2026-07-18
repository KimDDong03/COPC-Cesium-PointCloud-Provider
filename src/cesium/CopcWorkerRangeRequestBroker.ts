import type { Getter } from "copc";
import {
  createCopcRangeGetter,
  type CopcRangeGetterOptions,
  type CopcSourceDescriptor,
} from "../core/copc/createCopcRangeGetter";

export interface CopcWorkerRangeRequest {
  readonly sourceKey: string;
  readonly begin: number;
  readonly end: number;
  readonly fetchBegin?: number;
  readonly fetchEnd?: number;
}

export type CopcRangeGetterFactory = (
  source: CopcSourceDescriptor,
) => Getter;

interface RegisteredSource {
  readonly descriptor: CopcSourceDescriptor;
  getter?: Getter;
}

export class CopcWorkerRangeRequestBroker {
  private readonly createGetter: CopcRangeGetterFactory;
  private readonly sources = new Map<string, RegisteredSource>();

  constructor(
    createGetter: CopcRangeGetterFactory | undefined = undefined,
    rangeGetterOptions: CopcRangeGetterOptions = {},
  ) {
    this.createGetter =
      createGetter ??
      ((source) => defaultCreateGetter(source, rangeGetterOptions));
  }

  registerSource(descriptor: CopcSourceDescriptor): void {
    const existing = this.sources.get(descriptor.key);

    if (existing) {
      if (existing.descriptor.input !== descriptor.input) {
        throw new Error(
          `COPC source key is already registered with a different input: ${descriptor.key}`,
        );
      }

      return;
    }

    this.sources.set(descriptor.key, { descriptor });
  }

  async getRange(request: CopcWorkerRangeRequest): Promise<Uint8Array> {
    const source = this.sources.get(request.sourceKey);

    if (!source) {
      throw new Error(`COPC source is not registered: ${request.sourceKey}`);
    }

    const begin = readRangeOffset("begin", request.begin);
    const end = readRangeOffset("end", request.end);
    const fetchBegin = readRangeOffset(
      "fetchBegin",
      request.fetchBegin ?? begin,
    );
    const fetchEnd = readRangeOffset("fetchEnd", request.fetchEnd ?? end);

    validateRange("inner", begin, end);
    validateRange("outer", fetchBegin, fetchEnd);

    if (fetchBegin > begin || end > fetchEnd) {
      throw new Error(
        `COPC outer byte range ${fetchBegin}-${fetchEnd} must contain requested range ${begin}-${end}.`,
      );
    }

    const outerBytes = await this.getSourceGetter(source)(fetchBegin, fetchEnd);
    const offset = begin - fetchBegin;
    const byteLength = end - begin;

    if (outerBytes.byteLength < offset + byteLength) {
      throw new Error(
        `COPC range getter returned ${outerBytes.byteLength} bytes for requested outer range ${fetchBegin}-${fetchEnd}.`,
      );
    }

    return outerBytes.slice(offset, offset + byteLength);
  }

  clear(): void {
    this.sources.clear();
  }

  private getSourceGetter(source: RegisteredSource): Getter {
    if (!source.getter) {
      source.getter = this.createGetter(source.descriptor);
    }

    return source.getter;
  }
}

function defaultCreateGetter(
  source: CopcSourceDescriptor,
  options: CopcRangeGetterOptions = {},
): Getter {
  return createCopcRangeGetter(source.input, options);
}

function readRangeOffset(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `${name} must be a non-negative safe integer byte offset.`,
    );
  }

  return value;
}

function validateRange(name: string, begin: number, end: number): void {
  if (end < begin) {
    throw new Error(`${name} byte range end must be greater than or equal to begin.`);
  }
}
