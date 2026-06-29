import type { CopcNodePointSampleResult } from "./CopcPointDataSample";
import { CopcSource } from "./CopcSource";
import type { LoadNodePointSamplesOptions } from "./CopcSource";

export async function loadNodePointSamples(
  url: string,
  options: LoadNodePointSamplesOptions = {},
): Promise<CopcNodePointSampleResult> {
  return new CopcSource(url).loadNodePointSamples(options);
}
