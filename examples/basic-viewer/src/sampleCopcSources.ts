import {
  createDefaultCopcCoordinateTransforms,
  createProj4CoordinateTransforms,
  type CopcCoordinateTransformFactory,
  type CopcSourceInput,
} from "copc-cesium";

const HOBU_LIDAR_SAMPLE_ROOT = "https://s3.amazonaws.com/hobu-lidar";

export interface CopcSourceConfig {
  readonly label: string;
  readonly url: string;
  readonly source?: CopcSourceInput;
  readonly description: string;
  readonly coordinateTransforms: CopcCoordinateTransformFactory;
}

export interface SampleCopcSource extends CopcSourceConfig {
  readonly id: string;
}

export interface CustomCopcProjectionOptions {
  readonly sourceCrs?: string;
  readonly sourceDefinition?: string;
}

export const SAMPLE_COPC_SOURCES = [
  {
    id: "autzen-classified",
    label: "Autzen classified",
    url: `${HOBU_LIDAR_SAMPLE_ROOT}/autzen-classified.copc.laz`,
    description: "Public COPC sample using EPSG:2992 coordinates.",
    coordinateTransforms: createDefaultCopcCoordinateTransforms,
  },
  {
    id: "sofi-stadium",
    label: "SoFi Stadium",
    url: `${HOBU_LIDAR_SAMPLE_ROOT}/sofi.copc.laz`,
    description:
      "Public COPC sample using WGS84 / UTM zone 11N coordinates detected from its WKT metadata.",
    coordinateTransforms: createDefaultCopcCoordinateTransforms,
  },
] as const satisfies readonly SampleCopcSource[];

export const DEFAULT_SAMPLE_COPC_SOURCE = SAMPLE_COPC_SOURCES[0];

export function createCustomCopcSource(
  url: string,
  projection: CustomCopcProjectionOptions = {},
): CopcSourceConfig {
  const sourceCrs = projection.sourceCrs?.trim();
  const sourceDefinition = projection.sourceDefinition?.trim();

  if (sourceDefinition && !sourceCrs) {
    throw new Error("Source CRS is required when a proj4 definition is set.");
  }

  if (sourceCrs) {
    return {
      label: "Custom URL",
      url,
      description: `User-provided COPC URL using ${sourceCrs} coordinates.`,
      coordinateTransforms: createProj4CoordinateTransforms({
        sourceCrs,
        sourceDefinition: sourceDefinition || undefined,
      }),
    };
  }

  return {
    label: "Custom URL",
    url,
    description: "User-provided COPC URL using the default transform factory.",
    coordinateTransforms: createDefaultCopcCoordinateTransforms,
  };
}

export function createLocalFileCopcSource(
  file: File,
  projection: CustomCopcProjectionOptions = {},
): CopcSourceConfig {
  const sourceCrs = projection.sourceCrs?.trim();
  const sourceDefinition = projection.sourceDefinition?.trim();

  if (sourceDefinition && !sourceCrs) {
    throw new Error("Source CRS is required when a proj4 definition is set.");
  }

  if (sourceCrs) {
    return {
      label: "Local file",
      url: file.name,
      source: file,
      description: `Browser-selected COPC file using ${sourceCrs} coordinates.`,
      coordinateTransforms: createProj4CoordinateTransforms({
        sourceCrs,
        sourceDefinition: sourceDefinition || undefined,
      }),
    };
  }

  return {
    label: "Local file",
    url: file.name,
    source: file,
    description:
      "Browser-selected COPC file using the default transform factory.",
    coordinateTransforms: createDefaultCopcCoordinateTransforms,
  };
}
