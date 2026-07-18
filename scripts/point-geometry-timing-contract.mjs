export function hasExpectedPointGeometryTimingMetadata(
  timingText,
  timingData,
) {
  if (timingText === "Not available") {
    return true;
  }

  if (
    typeof timingText !== "string" ||
    !/\b\d[\d,]* nodes\b/.test(timingText) ||
    !/\b\d[\d,]* cache hits\b/.test(timingText) ||
    !/\bmax (?:view|decode)\b/.test(timingText) ||
    !/\bmax worker\b/.test(timingText)
  ) {
    return false;
  }

  if (timingData === undefined || timingData === null) {
    return true;
  }

  if (
    typeof timingData === "object" &&
    Number.isSafeInteger(timingData.nodeCount) &&
    timingData.nodeCount > 0 &&
    Number.isSafeInteger(timingData.cacheHitCount) &&
    timingData.cacheHitCount >= 0 &&
    timingData.cacheHitCount <= timingData.nodeCount &&
    typeof timingData.workerTotalMilliseconds === "number" &&
    Number.isFinite(timingData.workerTotalMilliseconds) &&
    timingData.workerTotalMilliseconds >= 0
  ) {
    return true;
  }

  return false;
}
