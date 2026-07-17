import type { Copc as CopcData, Hierarchy } from "copc";
import type { CopcNodePointSampleResult } from "../core/copc/CopcPointDataSample";
import type { CopcSourceDescriptor } from "../core/copc/createCopcRangeGetter";
import type { CopcDecodedPointDataCacheSnapshot } from "../core/copc/CopcDecodedPointDataCache";
import type { PointGeometryBatch } from "./CopcPointCloudRenderer";
import type { ResolvedCopcPointColorStyle } from "./copcPointColorizer";
import type { CesiumPointGeometryTransform } from "./pointGeometryBatch";

export type CesiumCopcPointGeometryWorkerRequest =
  | CesiumCopcPointGeometryWorkerWarmupRequest
  | CesiumCopcPointGeometryWorkerLoadRequest
  | CesiumCopcPointGeometryWorkerPrefetchRequest
  | CesiumCopcPointGeometryWorkerCancelRequest;

export type CesiumCopcPointGeometryWorkerWorkRequest =
  | CesiumCopcPointGeometryWorkerLoadRequest
  | CesiumCopcPointGeometryWorkerPrefetchRequest;

export interface CesiumCopcPointGeometryWorkerWarmupRequest {
  readonly id: number;
  readonly type: "warmup";
  readonly copc?: CopcData;
  readonly source?: CopcSourceDescriptor;
  readonly url?: string;
}

export interface CesiumCopcPointGeometryWorkerLoadRequest {
  readonly id: number;
  readonly type: "loadNodePointGeometry";
  readonly copc?: CopcData;
  readonly source?: CopcSourceDescriptor;
  readonly url?: string;
  readonly nodeKey: string;
  readonly node: Hierarchy.Node;
  readonly maxPointCount: number;
  readonly transform: CesiumPointGeometryTransform;
  readonly pointColorStyle?: ResolvedCopcPointColorStyle;
  readonly maxDecodedPointDataViews?: number;
  readonly maxDecodedPointDataViewBytes?: number;
}

export interface CesiumCopcPointGeometryWorkerPrefetchRequest {
  readonly id: number;
  readonly type: "prefetchNodePointData";
  readonly copc?: CopcData;
  readonly source?: CopcSourceDescriptor;
  readonly url?: string;
  readonly nodeKey: string;
  readonly node: Hierarchy.Node;
  readonly maxDecodedPointDataViews?: number;
  readonly maxDecodedPointDataViewBytes?: number;
}

export interface CesiumCopcPointGeometryWorkerCancelRequest {
  readonly id: number;
  readonly type: "cancel";
}

export interface CopcNodePointGeometryBatchResult {
  readonly pointSamples: CopcNodePointSampleResult;
  readonly geometryBatch: PointGeometryBatch;
  readonly timing?: CopcPointGeometryBatchTiming;
}

export interface CopcPointGeometryBatchTiming {
  readonly pointDataViewMilliseconds: number;
  readonly pointDataViewCacheHit: boolean;
  readonly sampleMilliseconds: number;
  readonly geometryMilliseconds: number;
  readonly workerTotalMilliseconds: number;
  readonly requestQueueMilliseconds?: number;
  readonly requestRoundTripMilliseconds?: number;
}

export interface CopcNodePointDataPrefetchResult {
  readonly nodeKey: string;
  readonly timing?: CopcPointDataPrefetchTiming;
}

export interface CopcPointDataPrefetchTiming {
  readonly pointDataViewMilliseconds: number;
  readonly pointDataViewCacheHit: boolean;
  readonly workerTotalMilliseconds: number;
  readonly requestQueueMilliseconds?: number;
  readonly requestRoundTripMilliseconds?: number;
}

export type CesiumCopcPointGeometryWorkerResponse =
  | CesiumCopcPointGeometryWorkerWarmupSuccessResponse
  | CesiumCopcPointGeometryWorkerWarmupErrorResponse
  | CesiumCopcPointGeometryWorkerSuccessResponse
  | CesiumCopcPointGeometryWorkerPrefetchSuccessResponse
  | CesiumCopcPointGeometryWorkerCanceledResponse
  | CesiumCopcPointGeometryWorkerPrefetchCanceledResponse
  | CesiumCopcPointGeometryWorkerErrorResponse;

export interface CesiumCopcPointGeometryWorkerWarmupSuccessResponse {
  readonly id: number;
  readonly type: "warmup:success";
}

export interface CesiumCopcPointGeometryWorkerWarmupErrorResponse {
  readonly id: number;
  readonly type: "warmup:error";
  readonly error: {
    readonly name?: string;
    readonly message: string;
    readonly stack?: string;
  };
}

export interface CesiumCopcPointGeometryWorkerSuccessResponse {
  readonly id: number;
  readonly type: "loadNodePointGeometry:success";
  readonly result: CopcNodePointGeometryBatchResult;
  readonly cache?: CopcDecodedPointDataCacheSnapshot;
}

export interface CesiumCopcPointGeometryWorkerPrefetchSuccessResponse {
  readonly id: number;
  readonly type: "prefetchNodePointData:success";
  readonly result: CopcNodePointDataPrefetchResult;
  readonly cache?: CopcDecodedPointDataCacheSnapshot;
}

export interface CesiumCopcPointGeometryWorkerCanceledResponse {
  readonly id: number;
  readonly type: "loadNodePointGeometry:canceled";
  readonly cache?: CopcDecodedPointDataCacheSnapshot;
}

export interface CesiumCopcPointGeometryWorkerPrefetchCanceledResponse {
  readonly id: number;
  readonly type: "prefetchNodePointData:canceled";
  readonly cache?: CopcDecodedPointDataCacheSnapshot;
}

export interface CesiumCopcPointGeometryWorkerErrorResponse {
  readonly id: number;
  readonly type: "loadNodePointGeometry:error" | "prefetchNodePointData:error";
  readonly cache?: CopcDecodedPointDataCacheSnapshot;
  readonly error: {
    readonly name?: string;
    readonly message: string;
    readonly stack?: string;
  };
}
