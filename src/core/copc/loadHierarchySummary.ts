import type { CopcHierarchySummary } from "./CopcHierarchySummary";
import { CopcSource } from "./CopcSource";

export async function loadHierarchySummary(
  url: string,
): Promise<CopcHierarchySummary> {
  return new CopcSource(url).loadHierarchySummary();
}
