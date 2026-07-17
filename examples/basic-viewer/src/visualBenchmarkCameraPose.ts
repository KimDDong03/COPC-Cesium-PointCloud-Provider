const CAMERA_POSE_FINGERPRINT_VALUE_COUNT = 21;
const VECTOR_COMPONENT_COUNT = 3;
const UNIT_VECTOR_TOLERANCE = 1e-9;
const ORTHOGONAL_TOLERANCE = 1e-9;

export interface VisualBenchmarkVector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface VisualBenchmarkCameraPose {
  readonly destination: VisualBenchmarkVector3;
  readonly direction: VisualBenchmarkVector3;
  readonly up: VisualBenchmarkVector3;
  readonly right: VisualBenchmarkVector3;
  readonly canvas: {
    readonly clientWidth: number;
    readonly clientHeight: number;
    readonly drawingBufferWidth: number;
    readonly drawingBufferHeight: number;
    readonly devicePixelRatio: number;
  };
  readonly frustum: {
    readonly fov: number;
    readonly aspectRatio: number;
    readonly near: number;
    readonly far: number;
  };
}

export function assertVisualBenchmarkCameraPoseAccess(
  visualBenchmarkMode: boolean,
): void {
  if (!visualBenchmarkMode) {
    throw new Error(
      "Camera-pose injection is only available with visualBenchmark=1.",
    );
  }
}

export function parseVisualBenchmarkCameraPoseFingerprint(
  fingerprint: string,
): VisualBenchmarkCameraPose {
  if (typeof fingerprint !== "string") {
    throw new Error("Camera pose fingerprint must be a string.");
  }

  const values = fingerprint.split("|").map(Number);

  if (
    values.length !== CAMERA_POSE_FINGERPRINT_VALUE_COUNT ||
    values.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      `Camera pose fingerprint must contain ${CAMERA_POSE_FINGERPRINT_VALUE_COUNT} finite values.`,
    );
  }

  const destination = createVector(values, 0);
  const direction = createVector(values, 3);
  const up = createVector(values, 6);
  const right = createVector(values, 9);
  const [
    clientWidth,
    clientHeight,
    drawingBufferWidth,
    drawingBufferHeight,
    devicePixelRatio,
    fov,
    aspectRatio,
    near,
    far,
  ] = values.slice(12);

  for (const [name, value] of [
    ["clientWidth", clientWidth],
    ["clientHeight", clientHeight],
    ["drawingBufferWidth", drawingBufferWidth],
    ["drawingBufferHeight", drawingBufferHeight],
  ] as const) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${name} must be a positive safe integer.`);
    }
  }
  if (devicePixelRatio <= 0) {
    throw new Error("devicePixelRatio must be positive.");
  }
  if (!(fov > 0 && fov < Math.PI)) {
    throw new Error("frustum fov must be between 0 and PI radians.");
  }
  if (aspectRatio <= 0) {
    throw new Error("frustum aspectRatio must be positive.");
  }
  if (!(near > 0 && far > near)) {
    throw new Error("frustum near/far must be positive and ordered.");
  }

  assertUnitVector("direction", direction);
  assertUnitVector("up", up);
  assertUnitVector("right", right);
  assertOrthogonal("direction/up", direction, up);
  assertOrthogonal("direction/right", direction, right);
  assertOrthogonal("up/right", up, right);

  return {
    destination,
    direction,
    up,
    right,
    canvas: {
      clientWidth,
      clientHeight,
      drawingBufferWidth,
      drawingBufferHeight,
      devicePixelRatio,
    },
    frustum: { fov, aspectRatio, near, far },
  };
}

export function formatVisualBenchmarkCameraPoseFingerprint(
  pose: VisualBenchmarkCameraPose,
): string {
  const values = [
    ...readVector(pose.destination),
    ...readVector(pose.direction),
    ...readVector(pose.up),
    ...readVector(pose.right),
    pose.canvas.clientWidth,
    pose.canvas.clientHeight,
    pose.canvas.drawingBufferWidth,
    pose.canvas.drawingBufferHeight,
    pose.canvas.devicePixelRatio,
    pose.frustum.fov,
    pose.frustum.aspectRatio,
    pose.frustum.near,
    pose.frustum.far,
  ];

  return values.map((value) => value.toPrecision(15)).join("|");
}

function createVector(
  values: readonly number[],
  offset: number,
): VisualBenchmarkVector3 {
  if (offset < 0 || offset + VECTOR_COMPONENT_COUNT > values.length) {
    throw new Error("Camera vector is missing components.");
  }

  return {
    x: values[offset],
    y: values[offset + 1],
    z: values[offset + 2],
  };
}

function readVector(vector: VisualBenchmarkVector3): readonly number[] {
  const values = [vector.x, vector.y, vector.z];
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Camera pose contains a non-finite vector component.");
  }
  return values;
}

function assertUnitVector(
  name: string,
  vector: VisualBenchmarkVector3,
): void {
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  if (Math.abs(magnitude - 1) > UNIT_VECTOR_TOLERANCE) {
    throw new Error(`${name} must be a unit vector.`);
  }
}

function assertOrthogonal(
  name: string,
  first: VisualBenchmarkVector3,
  second: VisualBenchmarkVector3,
): void {
  const dot = first.x * second.x + first.y * second.y + first.z * second.z;
  if (Math.abs(dot) > ORTHOGONAL_TOLERANCE) {
    throw new Error(`${name} vectors must be orthogonal.`);
  }
}
