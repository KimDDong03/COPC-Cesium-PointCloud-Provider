export const AUTZEN_SOURCE_URL =
  "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz";
export const EXPECTED_AUTZEN_ETAG =
  '"dbb36ebb301306feb94c5e313524492c-10"';
export const EPTIUM_STOCK_SCREEN_SPACE_ERROR = 32;
export const EPTIUM_AUTZEN_CAMERA_POSE_FINGERPRINT =
  "-2505572.94618036|-3848127.15457743|4413373.60468756|0.392131627297984|0.602246430491832|-0.695364669675187|0.379422248808840|0.582727020946622|0.718657064369034|0.838016434195343|-0.545644990830597|-1.72084568816899e-15|1600|900|1600|900|1|1.04719755119660|1.77777777777778|0.1|10000000000";

const DEFAULT_POINT_COUNT_RELATIVE_TOLERANCE = 0.01;

export function selectClosestEptiumCalibration(calibrations, targetPointCount) {
  if (!Number.isSafeInteger(targetPointCount) || targetPointCount <= 0) {
    throw new Error("targetPointCount must be a positive safe integer.");
  }

  const candidates = calibrations.filter(
    (calibration) =>
      Number.isFinite(calibration.screenSpaceError) &&
      calibration.screenSpaceError > 0 &&
      Number.isSafeInteger(calibration.pointCount) &&
      calibration.pointCount > 0,
  );
  if (candidates.length === 0) {
    throw new Error("At least one valid Eptium calibration is required.");
  }

  return candidates.reduce((closest, candidate) => {
    const candidateDelta = Math.abs(candidate.pointCount - targetPointCount);
    const closestDelta = Math.abs(closest.pointCount - targetPointCount);
    return candidateDelta < closestDelta ||
      (candidateDelta === closestDelta &&
        candidate.screenSpaceError < closest.screenSpaceError)
      ? candidate
      : closest;
  });
}

export function classifyPointCountEquivalence(
  baselinePointCount,
  candidatePointCount,
  tolerance = DEFAULT_POINT_COUNT_RELATIVE_TOLERANCE,
) {
  if (
    !Number.isSafeInteger(baselinePointCount) ||
    baselinePointCount <= 0 ||
    !Number.isSafeInteger(candidatePointCount) ||
    candidatePointCount <= 0
  ) {
    throw new Error("Point counts must be positive safe integers.");
  }
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new Error("Point-count tolerance must be non-negative.");
  }

  const absoluteDelta = Math.abs(candidatePointCount - baselinePointCount);
  const relativeDelta = absoluteDelta / baselinePointCount;
  return {
    classification:
      relativeDelta <= tolerance ? "equivalent" : "non-equivalent",
    baselinePointCount,
    candidatePointCount,
    absoluteDelta,
    relativeDelta,
    tolerance,
  };
}

export function createExternalCaptureConfigurations({
  oursBalancedPointBudget,
  oursDetailPointBudget,
  stockEptiumPointCount,
}) {
  for (const [name, value] of [
    ["oursBalancedPointBudget", oursBalancedPointBudget],
    ["oursDetailPointBudget", oursDetailPointBudget],
    ["stockEptiumPointCount", stockEptiumPointCount],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
  }

  return [
    {
      id: "eptium-stock",
      vendor: "eptium",
      screenSpaceError: EPTIUM_STOCK_SCREEN_SPACE_ERROR,
      expectedPointCount: stockEptiumPointCount,
    },
    {
      id: "ours-shipped-default",
      vendor: "ours",
      quality: "balanced",
      presetBasePointBudget: oursBalancedPointBudget,
    },
    {
      id: "ours-high-detail",
      vendor: "ours",
      quality: "detail",
      presetBasePointBudget: oursDetailPointBudget,
    },
    {
      id: "ours-equal-count",
      vendor: "ours",
      quality: "detail",
      pointBudget: stockEptiumPointCount,
    },
  ];
}

export function createExternalCapturePlan(configurations, repeats) {
  if (!Number.isSafeInteger(repeats) || repeats <= 0) {
    throw new Error("repeats must be a positive safe integer.");
  }
  if (!Array.isArray(configurations) || configurations.length === 0) {
    throw new Error("At least one capture configuration is required.");
  }

  const plan = [];
  for (let repeat = 1; repeat <= repeats; repeat += 1) {
    const ordered =
      repeat % 2 === 1 ? configurations : [...configurations].reverse();
    for (const configuration of ordered) {
      plan.push({
        ...configuration,
        repeat,
        order: plan.length + 1,
        captureId: `${configuration.id}-r${repeat}`,
      });
    }
  }
  return plan;
}

export function createExternalComparisonDefinitions() {
  return [
    {
      id: "shipped-defaults",
      comparisonMode: "shipped-defaults",
      baselineCaptureId: "eptium-stock",
      candidateCaptureId: "ours-shipped-default",
      pointCountExpectation: "descriptive-non-equivalent-allowed",
    },
    {
      id: "high-detail",
      comparisonMode: "current-high-detail",
      baselineCaptureId: "eptium-stock",
      candidateCaptureId: "ours-high-detail",
      pointCountExpectation: "descriptive-non-equivalent-allowed",
    },
    {
      id: "equal-count",
      comparisonMode: "budget-normalized-to-eptium-stock",
      baselineCaptureId: "eptium-stock",
      candidateCaptureId: "ours-equal-count",
      pointCountExpectation: "strict-equivalent",
    },
  ];
}

export function summarizeSourceResponses(responses, sourceUrl = AUTZEN_SOURCE_URL) {
  const matching = responses.filter((response) => response.url === sourceUrl);
  const statuses = countBy(matching, (response) => String(response.status));
  const etags = uniqueDefined(matching.map((response) => response.etag));
  const lastModified = uniqueDefined(
    matching.map((response) => response.lastModified),
  );
  const totalLengths = uniqueDefined(
    matching.map((response) => parseContentRangeTotal(response.contentRange)),
  );

  return {
    sourceUrl,
    responseCount: matching.length,
    statuses,
    etags,
    lastModified,
    totalLengths,
    acceptsRanges: uniqueDefined(
      matching.map((response) => response.acceptRanges),
    ),
    firstResponse: matching[0],
  };
}

const REQUEST_TRAFFIC_COALESCING_GAP_THRESHOLDS = [0, 4096, 16384, 65536];

export function summarizeSourceRequestTraffic(requests, sourceUrl) {
  if (!Array.isArray(requests)) {
    throw new Error("requests must be an array.");
  }

  const matching =
    sourceUrl === undefined
      ? requests
      : requests.filter((request) => request.url === sourceUrl);
  const byScope = {};
  for (const request of matching) {
    const scope =
      typeof request.scope === "string" && request.scope.length > 0
        ? request.scope
        : "unknown";
    byScope[scope] ??= [];
    byScope[scope].push(request);
  }

  return {
    sourceUrl,
    overall: summarizeRequestTrafficGroup(matching),
    byScope: Object.fromEntries(
      Object.entries(byScope).map(([scope, scopeRequests]) => [
        scope,
        summarizeRequestTrafficGroup(scopeRequests),
      ]),
    ),
  };
}

function summarizeRequestTrafficGroup(requests) {
  const statusCounts = countBy(
    requests.filter((request) => request.status !== undefined),
    (request) => String(request.status),
  );
  const outcomeCounts = countBy(requests, (request) =>
    request.outcome === "finished" ||
    request.outcome === "failed" ||
    request.outcome === "abandoned" ||
    request.outcome === "pending"
      ? request.outcome
      : "unknown",
  );

  const parsedRanges = [];
  let unparsedRangeCount = 0;
  let requestedBytes = 0;
  let respondedRequestedBytes = 0;
  let receivedBodyBytes = 0;
  let receivedHeaderBytes = 0;
  let transferBytes = 0;

  for (const request of requests) {
    const parsedRange = parseClosedByteRange(request.requestRange);
    if (parsedRange) {
      parsedRanges.push(parsedRange);
      requestedBytes += parsedRange.length;
      if (
        request.status !== undefined ||
        request.rangeContentLength !== undefined
      ) {
        respondedRequestedBytes += parsedRange.length;
      }
    } else if (request.requestRange !== undefined && request.requestRange !== null) {
      unparsedRangeCount += 1;
    }

    const bodySize =
      parseSafeNonNegativeInteger(request.rangeContentLength) ??
      parseSafeNonNegativeInteger(request.sizes?.responseBodySize);
    const headerSize = parseSafeNonNegativeInteger(
      request.sizes?.responseHeadersSize,
    );
    if (bodySize !== undefined) {
      receivedBodyBytes += bodySize;
    }
    if (headerSize !== undefined) {
      receivedHeaderBytes += headerSize;
    }
    if (bodySize !== undefined || headerSize !== undefined) {
      transferBytes += (bodySize ?? 0) + (headerSize ?? 0);
    }
  }

  const exactRangeCounts = countBy(parsedRanges, (range) => range.key);
  const uniqueRanges = [
    ...new Map(parsedRanges.map((range) => [range.key, range])).values(),
  ];
  const exactDuplicateRequestCount = parsedRanges.length - uniqueRanges.length;
  const exactDuplicateBytes = Object.entries(exactRangeCounts).reduce(
    (total, [rangeKey, count]) => {
      if (count <= 1) {
        return total;
      }
      const range = uniqueRanges.find((candidate) => candidate.key === rangeKey);
      return total + (range?.length ?? 0) * (count - 1);
    },
    0,
  );
  const unionUniqueRequestedBytes = calculateUnionBytes(uniqueRanges);
  const redundantOverlapBytes = Math.max(0, requestedBytes - unionUniqueRequestedBytes);

  return {
    requestCount: requests.length,
    finishedCount: outcomeCounts.finished ?? 0,
    failedCount: outcomeCounts.failed ?? 0,
    abandonedCount: outcomeCounts.abandoned ?? 0,
    pendingCount: outcomeCounts.pending ?? 0,
    unknownOutcomeCount: outcomeCounts.unknown ?? 0,
    statusCounts,
    requestedBytes,
    respondedRequestedBytes,
    receivedBodyBytes,
    receivedHeaderBytes,
    transferBytes,
    validRangeCount: parsedRanges.length,
    unparsedRangeCount,
    uniqueExactRangeCount: uniqueRanges.length,
    exactDuplicateRequestCount,
    exactDuplicateBytes,
    unionUniqueRequestedBytes,
    redundantOverlapBytes,
    amplificationRatio:
      unionUniqueRequestedBytes > 0 ? requestedBytes / unionUniqueRequestedBytes : undefined,
    adjacentRanges: findAdjacentRanges(uniqueRanges),
    coalescingEstimates: Object.fromEntries(
      REQUEST_TRAFFIC_COALESCING_GAP_THRESHOLDS.map((gapThreshold) => [
        String(gapThreshold),
        createCoalescingEstimate(uniqueRanges, unionUniqueRequestedBytes, gapThreshold),
      ]),
    ),
  };
}

function parseClosedByteRange(rangeHeader) {
  if (typeof rangeHeader !== "string") {
    return undefined;
  }
  const match = /^bytes=([0-9]+)-([0-9]+)$/i.exec(rangeHeader.trim());
  if (!match) {
    return undefined;
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start
  ) {
    return undefined;
  }
  return {
    start,
    end,
    length: end - start + 1,
    key: `${start}-${end}`,
  };
}

function parseSafeNonNegativeInteger(value) {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function calculateUnionBytes(ranges) {
  return mergeRanges(ranges, 0).reduce(
    (total, range) => total + range.end - range.start + 1,
    0,
  );
}

function findAdjacentRanges(ranges) {
  const sorted = sortRanges(ranges);
  const adjacent = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (previous.end + 1 === current.start) {
      adjacent.push({
        previous: previous.key,
        next: current.key,
      });
    }
  }
  return adjacent;
}

function createCoalescingEstimate(ranges, unionUniqueRequestedBytes, gapThreshold) {
  const spans = mergeRanges(ranges, gapThreshold);
  const fetchedBytes = spans.reduce(
    (total, span) => total + span.end - span.start + 1,
    0,
  );
  return {
    spanCount: spans.length,
    requestReduction: Math.max(0, ranges.length - spans.length),
    fetchedBytes,
    overfetchBytes: Math.max(0, fetchedBytes - unionUniqueRequestedBytes),
  };
}

function mergeRanges(ranges, gapThreshold) {
  const sorted = sortRanges(ranges);
  const merged = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range.start - previous.end - 1 > gapThreshold) {
      merged.push({ start: range.start, end: range.end });
      continue;
    }
    previous.end = Math.max(previous.end, range.end);
  }
  return merged;
}

function sortRanges(ranges) {
  return [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
}

function parseContentRangeTotal(contentRange) {
  if (typeof contentRange !== "string") {
    return undefined;
  }
  const match = /\/([0-9]+)$/.exec(contentRange);
  return match ? Number(match[1]) : undefined;
}

function countBy(values, selectKey) {
  const counts = {};
  for (const value of values) {
    const key = selectKey(value);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function uniqueDefined(values) {
  return [
    ...new Set(values.filter((value) => value !== undefined && value !== null)),
  ];
}
