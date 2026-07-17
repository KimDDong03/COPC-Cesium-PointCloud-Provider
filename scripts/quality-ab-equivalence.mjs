const CAMERA_FINGERPRINT_VALUE_COUNT = 21;
const POSITION_VALUE_COUNT = 3;
const ORIENTATION_END_INDEX = 12;
const CANVAS_END_INDEX = 17;
const DEFAULT_MAX_POSITION_DELTA_METERS = 0.00001;
const DEFAULT_MAX_RELATIVE_DELTA = 1e-12;

export function compareCameraPoseFingerprints(
  baselineFingerprint,
  candidateFingerprint,
  options = {},
) {
  const baseline = parseFingerprint(baselineFingerprint);
  const candidate = parseFingerprint(candidateFingerprint);
  const maxPositionDeltaMeters = maximumAbsoluteDelta(
    baseline.slice(0, POSITION_VALUE_COUNT),
    candidate.slice(0, POSITION_VALUE_COUNT),
  );
  const maxOrientationDelta = maximumAbsoluteDelta(
    baseline.slice(POSITION_VALUE_COUNT, ORIENTATION_END_INDEX),
    candidate.slice(POSITION_VALUE_COUNT, ORIENTATION_END_INDEX),
  );
  const canvasMatches = baseline
    .slice(ORIENTATION_END_INDEX, CANVAS_END_INDEX)
    .every((value, index) => value === candidate[ORIENTATION_END_INDEX + index]);
  const maxProjectionRelativeDelta = maximumRelativeDelta(
    baseline.slice(CANVAS_END_INDEX),
    candidate.slice(CANVAS_END_INDEX),
  );
  const positionTolerance = normalizePositiveNumber(
    options.maxPositionDeltaMeters,
    DEFAULT_MAX_POSITION_DELTA_METERS,
  );
  const relativeTolerance = normalizePositiveNumber(
    options.maxRelativeDelta,
    DEFAULT_MAX_RELATIVE_DELTA,
  );
  const matches =
    maxPositionDeltaMeters <= positionTolerance &&
    maxOrientationDelta <= relativeTolerance &&
    canvasMatches &&
    maxProjectionRelativeDelta <= relativeTolerance;

  return {
    matches,
    canvasMatches,
    maxPositionDeltaMeters,
    maxOrientationDelta,
    maxProjectionRelativeDelta,
    positionToleranceMeters: positionTolerance,
    relativeTolerance,
  };
}

function parseFingerprint(fingerprint) {
  if (typeof fingerprint !== "string") {
    throw new Error("Camera pose fingerprint must be a string.");
  }

  const values = fingerprint.split("|").map(Number);

  if (
    values.length !== CAMERA_FINGERPRINT_VALUE_COUNT ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      `Camera pose fingerprint must contain ${CAMERA_FINGERPRINT_VALUE_COUNT} finite values.`,
    );
  }

  return values;
}

function maximumAbsoluteDelta(first, second) {
  return first.reduce(
    (maximum, value, index) =>
      Math.max(maximum, Math.abs(value - second[index])),
    0,
  );
}

function maximumRelativeDelta(first, second) {
  return first.reduce((maximum, value, index) => {
    const candidate = second[index];
    const scale = Math.max(1, Math.abs(value), Math.abs(candidate));
    return Math.max(maximum, Math.abs(value - candidate) / scale);
  }, 0);
}

function normalizePositiveNumber(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}
