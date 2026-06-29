import type { CopcBounds } from "./CopcInspection";

export interface CopcHierarchyNodeSummary {
  readonly key: string;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly bounds: CopcBounds;
  readonly pointCount: number;
  readonly pointDensity: number;
  readonly pointDataOffset: number;
  readonly pointDataLength: number;
}

export interface CopcHierarchySummary {
  readonly nodes: readonly CopcHierarchyNodeSummary[];
  readonly pageCount: number;
}
