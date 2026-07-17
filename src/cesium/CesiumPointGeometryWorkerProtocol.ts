import type { CopcPointDataSampleArrays } from "../core/copc/CopcPointDataSample";
import type { PointGeometryBatch } from "./CopcPointCloudRenderer";
import type { ResolvedCopcPointColorStyle } from "./copcPointColorizer";
import type { CesiumPointGeometryTransform } from "./pointGeometryBatch";

export type CesiumPointGeometryWorkerRequest =
  | CesiumPointGeometryWorkerBuildRequest
  | CesiumPointGeometryWorkerCancelRequest;

export interface CesiumPointGeometryWorkerBuildRequest {
  readonly id: number;
  readonly type: "buildPointGeometryBatch";
  readonly key: string;
  readonly pointData: CopcPointDataSampleArrays;
  readonly transform: CesiumPointGeometryTransform;
  readonly pointColorStyle?: ResolvedCopcPointColorStyle;
}

export interface CesiumPointGeometryWorkerCancelRequest {
  readonly id: number;
  readonly type: "cancel";
}

export type CesiumPointGeometryWorkerResponse =
  | CesiumPointGeometryWorkerSuccessResponse
  | CesiumPointGeometryWorkerErrorResponse;

export interface CesiumPointGeometryWorkerSuccessResponse {
  readonly id: number;
  readonly type: "buildPointGeometryBatch:success";
  readonly batch: PointGeometryBatch;
}

export interface CesiumPointGeometryWorkerErrorResponse {
  readonly id: number;
  readonly type: "buildPointGeometryBatch:error";
  readonly error: {
    readonly name?: string;
    readonly message: string;
    readonly stack?: string;
  };
}
