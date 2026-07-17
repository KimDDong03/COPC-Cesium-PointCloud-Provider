export interface CreateSpatiallyDistributedPointIndicesOptions {
  readonly pointCount: number;
  readonly sampleCount: number;
  readonly getX: (index: number) => number;
  readonly getY: (index: number) => number;
  readonly getZ: (index: number) => number;
  readonly signal?: AbortSignal;
}

export const SPATIAL_POINT_ORDER_BYTES_PER_POINT =
  Uint32Array.BYTES_PER_ELEMENT;

const ABORT_CHECK_INTERVAL = 2_048;
const MORTON_AXIS_BITS = 10;
const MORTON_AXIS_SIZE = 2 ** MORTON_AXIS_BITS;
const RADIX_BUCKET_COUNT = 256;
const RADIX_BITS_PER_PASS = 8;
const RADIX_PASS_COUNT = 4;
const MAX_UINT32_INDEX = 0xffff_ffff;

interface CoordinateBounds {
  minimum: number;
  maximum: number;
}

interface PointBounds {
  readonly x: CoordinateBounds;
  readonly y: CoordinateBounds;
  readonly z: CoordinateBounds;
}

/**
 * Creates a deterministic progressive ordering of source point indices.
 *
 * Points are first ordered along a quantized 3D Morton curve. A centered
 * bit-reversal permutation then visits that order at successively finer
 * intervals. Consequently, every prefix, including the full-count ordering,
 * is spatially distributed and the first K indices are identical regardless
 * of the larger requested prefix.
 */
export function createSpatiallyDistributedPointIndices(
  options: CreateSpatiallyDistributedPointIndicesOptions,
): Uint32Array {
  validatePointCount("pointCount", options.pointCount);
  validatePointCount("sampleCount", options.sampleCount);
  throwIfAborted(options.signal);

  const sampleCount = Math.min(options.pointCount, options.sampleCount);

  if (sampleCount === 0) {
    return new Uint32Array(0);
  }

  if (options.pointCount > MAX_UINT32_INDEX) {
    throw new RangeError(
      "pointCount exceeds the maximum supported spatial sample index.",
    );
  }

  const bounds = calculatePointBounds(options);
  const mortonCodes = new Uint32Array(options.pointCount);
  const mortonOrder = new Uint32Array(options.pointCount);

  for (let pointIndex = 0; pointIndex < options.pointCount; pointIndex += 1) {
    checkForAbort(options.signal, pointIndex);
    mortonCodes[pointIndex] = createMortonCode(
      quantizeCoordinate(options.getX(pointIndex), bounds.x),
      quantizeCoordinate(options.getY(pointIndex), bounds.y),
      quantizeCoordinate(options.getZ(pointIndex), bounds.z),
    );
    mortonOrder[pointIndex] = pointIndex;
  }

  throwIfAborted(options.signal);
  const sortedMortonOrder = stableRadixSortMortonOrder(
    mortonOrder,
    mortonCodes,
    options.signal,
  );

  return createProgressiveMortonIndices(
    sortedMortonOrder,
    sampleCount,
    options.signal,
  );
}

function stableRadixSortMortonOrder(
  initialOrder: Uint32Array,
  mortonCodes: Uint32Array,
  signal: AbortSignal | undefined,
): Uint32Array {
  let source: Uint32Array = initialOrder;
  let target: Uint32Array = new Uint32Array(initialOrder.length);
  const bucketOffsets = new Uint32Array(RADIX_BUCKET_COUNT);

  for (let passIndex = 0; passIndex < RADIX_PASS_COUNT; passIndex += 1) {
    throwIfAborted(signal);
    bucketOffsets.fill(0);
    const bitShift = passIndex * RADIX_BITS_PER_PASS;

    for (let orderIndex = 0; orderIndex < source.length; orderIndex += 1) {
      checkForAbort(signal, orderIndex);
      const pointIndex = source[orderIndex] ?? 0;
      const bucket = ((mortonCodes[pointIndex] ?? 0) >>> bitShift) & 0xff;
      bucketOffsets[bucket] = (bucketOffsets[bucket] ?? 0) + 1;
    }

    let nextOffset = 0;

    for (let bucket = 0; bucket < RADIX_BUCKET_COUNT; bucket += 1) {
      const bucketSize = bucketOffsets[bucket] ?? 0;
      bucketOffsets[bucket] = nextOffset;
      nextOffset += bucketSize;
    }

    for (let orderIndex = 0; orderIndex < source.length; orderIndex += 1) {
      checkForAbort(signal, orderIndex);
      const pointIndex = source[orderIndex] ?? 0;
      const bucket = ((mortonCodes[pointIndex] ?? 0) >>> bitShift) & 0xff;
      const targetIndex = bucketOffsets[bucket] ?? 0;
      target[targetIndex] = pointIndex;
      bucketOffsets[bucket] = targetIndex + 1;
    }

    const previousSource = source;
    source = target;
    target = previousSource;
  }

  throwIfAborted(signal);
  return source;
}

function calculatePointBounds(
  options: CreateSpatiallyDistributedPointIndicesOptions,
): PointBounds {
  const bounds: PointBounds = {
    x: createEmptyCoordinateBounds(),
    y: createEmptyCoordinateBounds(),
    z: createEmptyCoordinateBounds(),
  };

  for (let pointIndex = 0; pointIndex < options.pointCount; pointIndex += 1) {
    checkForAbort(options.signal, pointIndex);
    includeCoordinate(bounds.x, options.getX(pointIndex));
    includeCoordinate(bounds.y, options.getY(pointIndex));
    includeCoordinate(bounds.z, options.getZ(pointIndex));
  }

  return bounds;
}

function createEmptyCoordinateBounds(): CoordinateBounds {
  return {
    minimum: Number.POSITIVE_INFINITY,
    maximum: Number.NEGATIVE_INFINITY,
  };
}

function includeCoordinate(bounds: CoordinateBounds, value: number): void {
  if (!Number.isFinite(value)) {
    return;
  }

  bounds.minimum = Math.min(bounds.minimum, value);
  bounds.maximum = Math.max(bounds.maximum, value);
}

function quantizeCoordinate(
  value: number,
  bounds: CoordinateBounds,
): number {
  if (!Number.isFinite(value)) {
    return Math.floor(MORTON_AXIS_SIZE / 2);
  }

  if (
    !Number.isFinite(bounds.minimum) ||
    !Number.isFinite(bounds.maximum) ||
    bounds.maximum <= bounds.minimum
  ) {
    return 0;
  }

  const range = bounds.maximum - bounds.minimum;
  const normalized = Number.isFinite(range)
    ? (value - bounds.minimum) / range
    : normalizeAcrossInfiniteRange(value, bounds);

  return Math.max(
    0,
    Math.min(
      MORTON_AXIS_SIZE - 1,
      Math.floor(normalized * MORTON_AXIS_SIZE),
    ),
  );
}

function normalizeAcrossInfiniteRange(
  value: number,
  bounds: CoordinateBounds,
): number {
  const scale = Math.max(
    Math.abs(bounds.minimum),
    Math.abs(bounds.maximum),
  );

  if (!Number.isFinite(scale) || scale === 0) {
    return 0;
  }

  const scaledMinimum = bounds.minimum / scale;
  const scaledRange = bounds.maximum / scale - scaledMinimum;

  if (!Number.isFinite(scaledRange) || scaledRange <= 0) {
    return 0;
  }

  return (value / scale - scaledMinimum) / scaledRange;
}

function createMortonCode(x: number, y: number, z: number): number {
  return (
    spreadMortonBits(x) |
    (spreadMortonBits(y) << 1) |
    (spreadMortonBits(z) << 2)
  ) >>> 0;
}

function spreadMortonBits(value: number): number {
  let spread = value & 0x0000_03ff;
  spread = (spread | (spread << 16)) & 0x0300_00ff;
  spread = (spread | (spread << 8)) & 0x0300_f00f;
  spread = (spread | (spread << 4)) & 0x030c_30c3;
  spread = (spread | (spread << 2)) & 0x0924_9249;
  return spread >>> 0;
}

function createProgressiveMortonIndices(
  mortonOrder: Uint32Array,
  sampleCount: number,
  signal: AbortSignal | undefined,
): Uint32Array {
  const pointCount = mortonOrder.length;
  const bitCount = Math.ceil(Math.log2(pointCount));
  const permutationSize = 2 ** bitCount;
  const halfPermutationSize = permutationSize / 2;
  const selectedIndices = new Uint32Array(sampleCount);
  let selectedCount = 0;

  for (
    let permutationIndex = 0;
    permutationIndex < permutationSize && selectedCount < sampleCount;
    permutationIndex += 1
  ) {
    checkForAbort(signal, permutationIndex);
    const reversedIndex = reverseLowestBits(permutationIndex, bitCount);
    const centeredIndex =
      reversedIndex < halfPermutationSize
        ? reversedIndex + halfPermutationSize
        : reversedIndex - halfPermutationSize;

    if (centeredIndex >= pointCount) {
      continue;
    }

    selectedIndices[selectedCount] = mortonOrder[centeredIndex] ?? 0;
    selectedCount += 1;
  }

  throwIfAborted(signal);
  return selectedIndices;
}

function reverseLowestBits(value: number, bitCount: number): number {
  let remaining = value;
  let reversed = 0;

  for (let bitIndex = 0; bitIndex < bitCount; bitIndex += 1) {
    reversed = reversed * 2 + (remaining % 2);
    remaining = Math.floor(remaining / 2);
  }

  return reversed;
}

function validatePointCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer.`);
  }
}

function checkForAbort(
  signal: AbortSignal | undefined,
  iteration: number,
): void {
  if ((iteration & (ABORT_CHECK_INTERVAL - 1)) === 0) {
    throwIfAborted(signal);
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  if (signal.reason instanceof Error) {
    throw signal.reason;
  }

  if (typeof DOMException !== "undefined") {
    throw new DOMException("COPC point sampling was aborted.", "AbortError");
  }

  const error = new Error("COPC point sampling was aborted.");
  error.name = "AbortError";
  throw error;
}
