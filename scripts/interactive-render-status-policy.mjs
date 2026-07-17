/**
 * Browser smoke checks normally recognize a render from its user-facing
 * status text. Exact-render reuse is different: no renderer submission occurs,
 * so accept it only when the structured current-view contract also proves that
 * the retained composition is terminal and complete.
 */
export function isInteractiveRenderReady(
  status,
  statusText,
  expectedRenderedStatuses,
) {
  if (
    Array.isArray(expectedRenderedStatuses) &&
    expectedRenderedStatuses.some((expectedStatus) =>
      statusText.includes(expectedStatus),
    )
  ) {
    return true;
  }

  const visualQuality = status?.cameraStreamVisualQuality;
  const isFrontierDepthPolicySatisfied =
    visualQuality?.isFrontierDepthPolicySatisfied ??
    visualQuality?.frontierDepthSpan === 0;

  return (
    typeof statusText === "string" &&
    statusText.startsWith("Camera stream retained ") &&
    status?.cameraStreamRenderDisposition === "retained-exact-render" &&
    visualQuality?.isTerminalReady === true &&
    isFrontierDepthPolicySatisfied &&
    visualQuality.isFrontierAntichain === true &&
    visualQuality.isAdditiveClosureComplete === true &&
    visualQuality.missingRequiredNodeCount === 0 &&
    visualQuality.unexpectedRenderedNodeCount === 0 &&
    visualQuality.pendingRelevantHierarchyPageCount === 0
  );
}
