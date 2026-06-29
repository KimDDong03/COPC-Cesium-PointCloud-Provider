export interface CopcPointColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}

export interface CopcPointDataSample {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly color?: CopcPointColor;
}

export interface CopcNodePointSampleResult {
  readonly nodeKey: string;
  readonly nodePointCount: number;
  readonly sampledPointCount: number;
  readonly points: readonly CopcPointDataSample[];
}

export interface CopcMultiNodePointSampleResult {
  readonly nodeKeys: readonly string[];
  readonly nodeResults: readonly CopcNodePointSampleResult[];
  readonly nodePointCount: number;
  readonly sampledPointCount: number;
  readonly points: readonly CopcPointDataSample[];
}
