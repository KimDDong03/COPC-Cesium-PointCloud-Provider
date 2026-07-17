const DEFAULT_GRID_COLUMNS = 32;
const DEFAULT_GRID_ROWS = 18;
const DEFAULT_GAP_RADIUS = 3;
const DEFAULT_BASELINE_SUPPORT_RADIUS = 3;

export function createPointDifferenceMask(
  pointImage,
  backgroundImage,
  colorDeltaThreshold = 12,
) {
  assertComparableImages(pointImage, backgroundImage);
  const threshold = normalizePositiveInteger(colorDeltaThreshold, 12);
  const pixelCount = pointImage.width * pointImage.height;
  const mask = new Uint8Array(pixelCount);

  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex += 1) {
    const offset = pixelIndex * 4;
    const maximumColorDelta = Math.max(
      Math.abs(pointImage.data[offset] - backgroundImage.data[offset]),
      Math.abs(pointImage.data[offset + 1] - backgroundImage.data[offset + 1]),
      Math.abs(pointImage.data[offset + 2] - backgroundImage.data[offset + 2]),
    );

    mask[pixelIndex] = maximumColorDelta >= threshold ? 1 : 0;
  }

  return mask;
}

export function analyzePointCloudImagePair(
  pointImage,
  backgroundImage,
  options = {},
) {
  const thresholds = uniquePositiveIntegers(
    options.colorDeltaThresholds ?? [8, 12, 20],
  );
  const primaryThreshold = normalizePositiveInteger(
    options.primaryColorDeltaThreshold,
    12,
  );

  if (!thresholds.includes(primaryThreshold)) {
    thresholds.push(primaryThreshold);
    thresholds.sort((left, right) => left - right);
  }

  const sensitivity = Object.fromEntries(
    thresholds.map((threshold) => {
      const mask = createPointDifferenceMask(
        pointImage,
        backgroundImage,
        threshold,
      );

      return [
        String(threshold),
        analyzePointCloudMask(mask, pointImage.width, pointImage.height, {
          ...options,
          includeMorphology: threshold === primaryThreshold,
        }),
      ];
    }),
  );

  return {
    primaryColorDeltaThreshold: primaryThreshold,
    primary: sensitivity[String(primaryThreshold)],
    sensitivity,
  };
}

export function analyzePointCloudMask(mask, width, height, options = {}) {
  assertMaskDimensions(mask, width, height);
  const pixelCount = width * height;
  const foregroundPixelCount = countMaskPixels(mask);
  const occupiedCellRatio = createOccupiedCellRatio(
    mask,
    width,
    height,
    normalizePositiveInteger(options.gridColumns, DEFAULT_GRID_COLUMNS),
    normalizePositiveInteger(options.gridRows, DEFAULT_GRID_ROWS),
  );
  const boundedGapMask = createBoundedGapMask(
    mask,
    width,
    height,
    normalizePositiveInteger(options.gapRadius, DEFAULT_GAP_RADIUS),
  );
  const boundedGapPixelCount = countMaskPixels(boundedGapMask);
  let isolatedForegroundPixelCount = 0;
  let foregroundEdgePerimeter = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;

      if (mask[index] === 0) {
        continue;
      }

      if (!hasForegroundNeighbour(mask, width, height, x, y)) {
        isolatedForegroundPixelCount += 1;
      }

      foregroundEdgePerimeter += countForegroundEdges(
        mask,
        width,
        height,
        x,
        y,
      );
    }
  }

  const result = {
    width,
    height,
    pixelCount,
    foregroundPixelCount,
    canvasCoverageRatio:
      pixelCount > 0 ? foregroundPixelCount / pixelCount : 0,
    occupiedCellRatio,
    boundedGapPixelCount,
    boundedGapRatio:
      foregroundPixelCount + boundedGapPixelCount > 0
        ? boundedGapPixelCount /
          (foregroundPixelCount + boundedGapPixelCount)
        : 0,
    isolatedForegroundPixelCount,
    isolatedForegroundRatio:
      foregroundPixelCount > 0
        ? isolatedForegroundPixelCount / foregroundPixelCount
        : 0,
    foregroundEdgePerimeter,
    edgePerimeterPerForegroundPixel:
      foregroundPixelCount > 0
        ? foregroundEdgePerimeter / foregroundPixelCount
        : 0,
  };

  if (options.includeMorphology === false) {
    return result;
  }

  return {
    ...result,
    microHoleRatioByRadius: Object.fromEntries(
      [1, 2, 3].map((radius) => {
        const closedMask = closeMaskSquare(mask, width, height, radius);
        let filledPixelCount = 0;

        for (let index = 0; index < mask.length; index += 1) {
          if (mask[index] === 0 && closedMask[index] !== 0) {
            filledPixelCount += 1;
          }
        }

        return [
          String(radius),
          {
            filledPixelCount,
            ratio:
              foregroundPixelCount + filledPixelCount > 0
                ? filledPixelCount /
                  (foregroundPixelCount + filledPixelCount)
                : 0,
          },
        ];
      }),
    ),
  };
}

/**
 * Checks that a candidate closes local holes without painting far outside the
 * baseline point support. The dilated support deliberately permits a small
 * splat/FXAA expansion while preserving large dataset voids and the footprint
 * boundary as a separate quality contract from raw coverage.
 */
export function comparePointCloudMaskSupport(
  baselineMask,
  candidateMask,
  width,
  height,
  options = {},
) {
  assertMaskDimensions(baselineMask, width, height);
  assertMaskDimensions(candidateMask, width, height);
  const supportRadius = normalizeNonNegativeInteger(
    options.supportRadius,
    DEFAULT_BASELINE_SUPPORT_RADIUS,
  );
  const baselineSupportMask = dilateMaskSquare(
    baselineMask,
    width,
    height,
    supportRadius,
  );
  let baselineForegroundPixelCount = 0;
  let candidateForegroundPixelCount = 0;
  let retainedBaselineForegroundPixelCount = 0;
  let supportedCandidateExpansionPixelCount = 0;
  let unsupportedCandidateForegroundPixelCount = 0;
  let largeBaselineVoidPixelCount = 0;

  for (let index = 0; index < baselineMask.length; index += 1) {
    const baselineForeground = baselineMask[index] !== 0;
    const candidateForeground = candidateMask[index] !== 0;
    const insideBaselineSupport = baselineSupportMask[index] !== 0;

    baselineForegroundPixelCount += baselineForeground ? 1 : 0;
    candidateForegroundPixelCount += candidateForeground ? 1 : 0;
    retainedBaselineForegroundPixelCount +=
      baselineForeground && candidateForeground ? 1 : 0;
    supportedCandidateExpansionPixelCount +=
      !baselineForeground && candidateForeground && insideBaselineSupport
        ? 1
        : 0;
    unsupportedCandidateForegroundPixelCount +=
      candidateForeground && !insideBaselineSupport ? 1 : 0;
    largeBaselineVoidPixelCount += insideBaselineSupport ? 0 : 1;
  }

  return {
    supportRadius,
    baselineForegroundPixelCount,
    candidateForegroundPixelCount,
    retainedBaselineForegroundPixelCount,
    baselineForegroundRetentionRatio:
      baselineForegroundPixelCount > 0
        ? retainedBaselineForegroundPixelCount /
          baselineForegroundPixelCount
        : candidateForegroundPixelCount === 0
          ? 1
          : 0,
    supportedCandidateExpansionPixelCount,
    unsupportedCandidateForegroundPixelCount,
    unsupportedCandidateForegroundRatio:
      candidateForegroundPixelCount > 0
        ? unsupportedCandidateForegroundPixelCount /
          candidateForegroundPixelCount
        : 0,
    largeBaselineVoidPixelCount,
    largeVoidIntrusionRatio:
      largeBaselineVoidPixelCount > 0
        ? unsupportedCandidateForegroundPixelCount /
          largeBaselineVoidPixelCount
        : unsupportedCandidateForegroundPixelCount === 0
          ? 0
          : 1,
  };
}

export function createMaskRgba(mask, width, height) {
  assertMaskDimensions(mask, width, height);
  const rgba = new Uint8Array(width * height * 4);

  for (let index = 0; index < mask.length; index += 1) {
    const value = mask[index] === 0 ? 0 : 255;
    const offset = index * 4;

    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }

  return rgba;
}

function createOccupiedCellRatio(
  mask,
  width,
  height,
  gridColumns,
  gridRows,
) {
  let occupiedCellCount = 0;

  for (let cellY = 0; cellY < gridRows; cellY += 1) {
    const minY = Math.floor((cellY * height) / gridRows);
    const maxY = Math.floor(((cellY + 1) * height) / gridRows);

    for (let cellX = 0; cellX < gridColumns; cellX += 1) {
      const minX = Math.floor((cellX * width) / gridColumns);
      const maxX = Math.floor(((cellX + 1) * width) / gridColumns);
      let occupied = false;

      for (let y = minY; y < maxY && !occupied; y += 1) {
        for (let x = minX; x < maxX; x += 1) {
          if (mask[y * width + x] !== 0) {
            occupied = true;
            break;
          }
        }
      }

      occupiedCellCount += occupied ? 1 : 0;
    }
  }

  const cellCount = gridColumns * gridRows;
  return cellCount > 0 ? occupiedCellCount / cellCount : 0;
}

function createBoundedGapMask(mask, width, height, maxGapLength) {
  const gaps = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    markBoundedGapsOnLine(
      mask,
      gaps,
      Array.from({ length: width }, (_, x) => y * width + x),
      maxGapLength,
    );
  }
  for (let x = 0; x < width; x += 1) {
    markBoundedGapsOnLine(
      mask,
      gaps,
      Array.from({ length: height }, (_, y) => y * width + x),
      maxGapLength,
    );
  }

  for (let startX = 0; startX < width; startX += 1) {
    markBoundedGapsOnLine(
      mask,
      gaps,
      createDiagonalIndexes(width, height, startX, 0, 1),
      maxGapLength,
    );
    markBoundedGapsOnLine(
      mask,
      gaps,
      createDiagonalIndexes(width, height, startX, height - 1, -1),
      maxGapLength,
    );
  }
  for (let startY = 1; startY < height; startY += 1) {
    markBoundedGapsOnLine(
      mask,
      gaps,
      createDiagonalIndexes(width, height, 0, startY, 1),
      maxGapLength,
    );
  }
  for (let startY = height - 2; startY >= 0; startY -= 1) {
    markBoundedGapsOnLine(
      mask,
      gaps,
      createDiagonalIndexes(width, height, 0, startY, -1),
      maxGapLength,
    );
  }

  return gaps;
}

function createDiagonalIndexes(width, height, startX, startY, directionY) {
  const indexes = [];
  let x = startX;
  let y = startY;

  while (x < width && y >= 0 && y < height) {
    indexes.push(y * width + x);
    x += 1;
    y += directionY;
  }

  return indexes;
}

function markBoundedGapsOnLine(mask, gaps, indexes, maxGapLength) {
  let index = 1;

  while (index < indexes.length - 1) {
    if (mask[indexes[index]] !== 0) {
      index += 1;
      continue;
    }

    const gapStart = index;
    while (index < indexes.length && mask[indexes[index]] === 0) {
      index += 1;
    }
    const gapLength = index - gapStart;
    const isBounded =
      gapStart > 0 &&
      index < indexes.length &&
      mask[indexes[gapStart - 1]] !== 0 &&
      mask[indexes[index]] !== 0;

    if (isBounded && gapLength <= maxGapLength) {
      for (let gapIndex = gapStart; gapIndex < index; gapIndex += 1) {
        gaps[indexes[gapIndex]] = 1;
      }
    }
  }
}

function closeMaskSquare(mask, width, height, radius) {
  return erodeMaskSquare(
    dilateMaskSquare(mask, width, height, radius),
    width,
    height,
    radius,
  );
}

function dilateMaskSquare(mask, width, height, radius) {
  const integral = createIntegralMask(mask, width, height);
  const result = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      result[y * width + x] =
        readIntegralRectangle(
          integral,
          width,
          Math.max(0, x - radius),
          Math.max(0, y - radius),
          Math.min(width, x + radius + 1),
          Math.min(height, y + radius + 1),
        ) > 0
          ? 1
          : 0;
    }
  }

  return result;
}

function erodeMaskSquare(mask, width, height, radius) {
  const integral = createIntegralMask(mask, width, height);
  const result = new Uint8Array(mask.length);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const minX = x - radius;
      const minY = y - radius;
      const maxX = x + radius + 1;
      const maxY = y + radius + 1;

      if (minX < 0 || minY < 0 || maxX > width || maxY > height) {
        continue;
      }

      const area = (maxX - minX) * (maxY - minY);
      result[y * width + x] =
        readIntegralRectangle(
          integral,
          width,
          minX,
          minY,
          maxX,
          maxY,
        ) === area
          ? 1
          : 0;
    }
  }

  return result;
}

function createIntegralMask(mask, width, height) {
  const stride = width + 1;
  const integral = new Uint32Array((width + 1) * (height + 1));

  for (let y = 0; y < height; y += 1) {
    let rowTotal = 0;

    for (let x = 0; x < width; x += 1) {
      rowTotal += mask[y * width + x] === 0 ? 0 : 1;
      integral[(y + 1) * stride + x + 1] =
        integral[y * stride + x + 1] + rowTotal;
    }
  }

  return integral;
}

function readIntegralRectangle(
  integral,
  width,
  minX,
  minY,
  maxX,
  maxY,
) {
  const stride = width + 1;
  return (
    integral[maxY * stride + maxX] -
    integral[minY * stride + maxX] -
    integral[maxY * stride + minX] +
    integral[minY * stride + minX]
  );
}

function hasForegroundNeighbour(mask, width, height, x, y) {
  for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      if (offsetX === 0 && offsetY === 0) {
        continue;
      }

      const neighbourX = x + offsetX;
      const neighbourY = y + offsetY;

      if (
        neighbourX >= 0 &&
        neighbourX < width &&
        neighbourY >= 0 &&
        neighbourY < height &&
        mask[neighbourY * width + neighbourX] !== 0
      ) {
        return true;
      }
    }
  }

  return false;
}

function countForegroundEdges(mask, width, height, x, y) {
  let edges = 0;

  for (const [offsetX, offsetY] of [
    [-1, 0],
    [1, 0],
    [0, -1],
    [0, 1],
  ]) {
    const neighbourX = x + offsetX;
    const neighbourY = y + offsetY;

    if (
      neighbourX < 0 ||
      neighbourX >= width ||
      neighbourY < 0 ||
      neighbourY >= height ||
      mask[neighbourY * width + neighbourX] === 0
    ) {
      edges += 1;
    }
  }

  return edges;
}

function countMaskPixels(mask) {
  let count = 0;

  for (const value of mask) {
    count += value === 0 ? 0 : 1;
  }

  return count;
}

function assertComparableImages(first, second) {
  if (
    first.width !== second.width ||
    first.height !== second.height ||
    first.data.length !== second.data.length
  ) {
    throw new Error("Point-on and point-off images must have equal dimensions.");
  }
}

function assertMaskDimensions(mask, width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    mask.length !== width * height
  ) {
    throw new Error("Mask dimensions do not match its pixel buffer.");
  }
}

function uniquePositiveIntegers(values) {
  return [
    ...new Set(
      values.map((value) => normalizePositiveInteger(value, 1)),
    ),
  ].sort((left, right) => left - right);
}

function normalizePositiveInteger(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function normalizeNonNegativeInteger(value, fallback) {
  return Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}
