import { classifyLiveCopcExecutionFailure } from "./live-copc-range-check.mjs";

const liveRangeStep = "Live COPC HTTP Range evidence";
const packageSmokeStep = "Package consumer smoke";

export function classifyQcStepFailure(groupId, label, result) {
  if (groupId === "product") {
    return "product-regression";
  }

  if (label === liveRangeStep) {
    return result.status === 2
      ? "external-source-unavailable"
      : "live-source-contract-failure";
  }

  if (groupId === "release-functional") {
    const liveFailure = classifyLiveCopcExecutionFailure(result.output);

    if (liveFailure === "external-source-unavailable") {
      return liveFailure;
    }

    return label === packageSmokeStep
      ? "package-functional-regression"
      : "live-functional-regression";
  }

  return classifyLiveCopcExecutionFailure(result.output);
}

export function getQcFailureGuidance(groupId, classification) {
  if (classification === "external-source-unavailable") {
    return "The external COPC host or network was unavailable; deterministic product checks are reported separately and this is not a code-regression verdict.";
  }

  if (groupId === "release-functional") {
    return "A hosted release functional check failed.";
  }

  if (groupId === "live") {
    return "The live source was reachable, so this remains a blocking live-evidence failure.";
  }

  return "A deterministic product check failed.";
}
