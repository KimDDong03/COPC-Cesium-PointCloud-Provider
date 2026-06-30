import type { Hierarchy } from "copc";
import type { CopcNodePointSampleResult } from "./CopcPointDataSample";

export interface CopcPointSampleWorkerRequest {
  readonly id: number;
  readonly type: "loadNodePointSamples";
  readonly url: string;
  readonly nodeKey: string;
  readonly node: Hierarchy.Node;
  readonly maxPointCount: number;
}

export type CopcPointSampleWorkerResponse =
  | CopcPointSampleWorkerSuccessResponse
  | CopcPointSampleWorkerErrorResponse;

export interface CopcPointSampleWorkerSuccessResponse {
  readonly id: number;
  readonly type: "loadNodePointSamples:success";
  readonly result: CopcNodePointSampleResult;
}

export interface CopcPointSampleWorkerErrorResponse {
  readonly id: number;
  readonly type: "loadNodePointSamples:error";
  readonly error: {
    readonly name?: string;
    readonly message: string;
    readonly stack?: string;
  };
}
