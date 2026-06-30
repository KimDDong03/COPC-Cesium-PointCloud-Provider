import {
  createDefaultCopcCoordinateTransforms,
  type CopcCoordinateTransformFactory,
} from "copc-viewer";

export interface CopcSourceConfig {
  readonly label: string;
  readonly url: string;
  readonly description: string;
  readonly coordinateTransforms: CopcCoordinateTransformFactory;
}

export interface SampleCopcSource extends CopcSourceConfig {
  readonly id: string;
}

export const SAMPLE_COPC_SOURCES = [
  {
    id: "autzen-classified",
    label: "Autzen classified",
    url: "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz",
    description: "Public COPC sample using EPSG:2992 coordinates.",
    coordinateTransforms: createDefaultCopcCoordinateTransforms,
  },
] as const satisfies readonly SampleCopcSource[];

export const DEFAULT_SAMPLE_COPC_SOURCE = SAMPLE_COPC_SOURCES[0];

export function createCustomCopcSource(url: string): CopcSourceConfig {
  return {
    label: "Custom URL",
    url,
    description: "User-provided COPC URL using the default transform factory.",
    coordinateTransforms: createDefaultCopcCoordinateTransforms,
  };
}
