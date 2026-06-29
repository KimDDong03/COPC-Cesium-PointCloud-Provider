import type { CopcInspection } from "./CopcInspection";
import { CopcSource } from "./CopcSource";

export async function inspectCopc(url: string): Promise<CopcInspection> {
  return new CopcSource(url).inspect();
}
