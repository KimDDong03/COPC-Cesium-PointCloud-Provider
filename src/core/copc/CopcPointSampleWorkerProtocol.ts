import type { Copc as CopcData, Hierarchy } from "copc";
import type { CopcSourceDescriptor } from "./createCopcRangeGetter";
import type {
  CopcNodePointSampleResult,
  CopcPointSampleFormat,
} from "./CopcPointDataSample";
import type { CopcDecodedPointDataCacheSnapshot } from "./CopcDecodedPointDataCache";

export type CopcPointSampleWorkerRequest =
  | CopcPointSampleWorkerLoadRequest
  | CopcPointSampleWorkerCancelRequest;

export interface CopcPointSampleWorkerLoadRequest {
  readonly id: number;
  readonly type: "loadNodePointSamples";
  readonly copc?: CopcData;
  readonly source?: CopcSourceDescriptor;
  readonly url?: string;
  readonly nodeKey: string;
  readonly node: Hierarchy.Node;
  readonly maxPointCount: number;
  readonly sampleFormat?: CopcPointSampleFormat;
  readonly maxDecodedPointDataViews?: number;
  readonly maxDecodedPointDataViewBytes?: number;
}

export interface CopcPointSampleWorkerCancelRequest {
  readonly id: number;
  readonly type: "cancel";
}

export type CopcPointSampleWorkerResponse =
  | CopcPointSampleWorkerSuccessResponse
  | CopcPointSampleWorkerCanceledResponse
  | CopcPointSampleWorkerErrorResponse;

export interface CopcPointSampleWorkerSuccessResponse {
  readonly id: number;
  readonly type: "loadNodePointSamples:success";
  readonly result: CopcNodePointSampleResult;
  readonly cache?: CopcDecodedPointDataCacheSnapshot;
}

export interface CopcPointSampleWorkerErrorResponse {
  readonly id: number;
  readonly type: "loadNodePointSamples:error";
  readonly cache?: CopcDecodedPointDataCacheSnapshot;
  readonly error: {
    readonly name?: string;
    readonly message: string;
    readonly stack?: string;
  };
}

export interface CopcPointSampleWorkerCanceledResponse {
  readonly id: number;
  readonly type: "loadNodePointSamples:canceled";
  readonly cache?: CopcDecodedPointDataCacheSnapshot;
}
