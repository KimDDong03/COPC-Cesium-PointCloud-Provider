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

export type CesiumCopcPointGeometryWorkerInboundMessage =
  | CesiumCopcPointGeometryWorkerRequest
  | CesiumCopcPointGeometryWorkerRangeSuccessMessage
  | CesiumCopcPointGeometryWorkerRangeErrorMessage;

export type CesiumCopcPointGeometryWorkerWorkRequest =
  | CesiumCopcPointGeometryWorkerLoadRequest
  | CesiumCopcPointGeometryWorkerPrefetchRequest;

export interface CesiumCopcPointGeometryWorkerHalfOpenRange {
  readonly begin: number;
  readonly end: number;
}

export interface CesiumCopcPointGeometryWorkerWarmupRequest {
  readonly id: number;
  readonly type: "warmup";
  readonly copc?: CopcData;
  readonly source?: CopcSourceDescriptor;
  readonly url?: string;
  readonly brokeredRangeRequests?: boolean;
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
  readonly brokeredRangeRequests?: boolean;
  readonly pointDataRange?: CesiumCopcPointGeometryWorkerHalfOpenRange;
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
  readonly brokeredRangeRequests?: boolean;
  readonly pointDataRange?: CesiumCopcPointGeometryWorkerHalfOpenRange;
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
  readonly pointDataViewRangeWaitMilliseconds?: number;
  readonly pointDataViewRangeRequestCount?: number;
  readonly pointDataViewRangeBytes?: number;
  readonly pointDataViewLazPerfMilliseconds?: number;
  readonly pointDataViewNonRangeMilliseconds?: number;
  readonly pointDataViewCacheWaitMilliseconds?: number;
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
  readonly pointDataViewRangeWaitMilliseconds?: number;
  readonly pointDataViewRangeRequestCount?: number;
  readonly pointDataViewRangeBytes?: number;
  readonly pointDataViewLazPerfMilliseconds?: number;
  readonly pointDataViewNonRangeMilliseconds?: number;
  readonly pointDataViewCacheWaitMilliseconds?: number;
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

export type CesiumCopcPointGeometryWorkerOutboundMessage =
  | CesiumCopcPointGeometryWorkerResponse
  | CesiumCopcPointGeometryWorkerRangeRequestMessage;

export interface CesiumCopcPointGeometryWorkerSerializedError {
  readonly name?: string;
  readonly message: string;
  readonly stack?: string;
}

export interface CesiumCopcPointGeometryWorkerRangeRequestMessage {
  readonly type: "range:request";
  readonly rangeRequestId: number;
  readonly sourceKey: string;
  readonly begin: number;
  readonly end: number;
  readonly fetchBegin?: number;
  readonly fetchEnd?: number;
}

export interface CesiumCopcPointGeometryWorkerRangeSuccessMessage {
  readonly type: "range:success";
  readonly rangeRequestId: number;
  readonly buffer: ArrayBuffer;
}

export interface CesiumCopcPointGeometryWorkerRangeErrorMessage {
  readonly type: "range:error";
  readonly rangeRequestId: number;
  readonly error: CesiumCopcPointGeometryWorkerSerializedError;
}

export interface CesiumCopcPointGeometryWorkerWarmupSuccessResponse {
  readonly id: number;
  readonly type: "warmup:success";
}

export interface CesiumCopcPointGeometryWorkerWarmupErrorResponse {
  readonly id: number;
  readonly type: "warmup:error";
  readonly error: CesiumCopcPointGeometryWorkerSerializedError;
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
  readonly error: CesiumCopcPointGeometryWorkerSerializedError;
}
