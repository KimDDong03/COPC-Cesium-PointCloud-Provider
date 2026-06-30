import type { CopcBounds, CopcHierarchyPageSummary } from "./CopcInspection";

export interface CopcHierarchyPageReference extends CopcHierarchyPageSummary {
  readonly key: string;
  readonly sourceHierarchyPageId?: string;
  readonly depth: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly bounds: CopcBounds;
}

export interface CopcHierarchyNodeSummary {
  readonly key: string;
  readonly sourceHierarchyPageId?: string;
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
  readonly pendingPages: readonly CopcHierarchyPageReference[];
  readonly pageCount: number;
  readonly loadedPageCount: number;
  readonly pendingPageCount: number;
}

export interface CopcHierarchyCacheStats {
  readonly loadedPageCount: number;
  readonly maxCachedPageCount: number;
  readonly pendingPageCount: number;
  readonly trackedNodeCount: number;
  readonly trackedPendingPageCount: number;
  readonly cacheEvictionCount: number;
  readonly isOverLimit: boolean;
}
