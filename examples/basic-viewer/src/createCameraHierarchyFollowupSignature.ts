export interface CameraHierarchyFollowupSignatureRefinement {
  readonly pendingRelevantHierarchyPageCount: number;
  readonly pendingRelevantHierarchyPageSignature: string | undefined;
  readonly isHierarchyCompleteForView: boolean;
  readonly refinedThroughDepth?: number;
}

export function createCameraHierarchyFollowupSignature(
  refinement: CameraHierarchyFollowupSignatureRefinement,
  selectedNodeKeys: readonly string[],
): string {
  const hierarchySignature = refinement.isHierarchyCompleteForView
    ? "complete"
    : `pending:${refinement.pendingRelevantHierarchyPageSignature ?? refinement.pendingRelevantHierarchyPageCount}`;
  const refinedThroughDepth =
    refinement.refinedThroughDepth === undefined
      ? "unknown"
      : refinement.refinedThroughDepth;

  return `depth:${refinedThroughDepth}|${hierarchySignature}|nodes:${[...selectedNodeKeys].sort().join("|")}`;
}
