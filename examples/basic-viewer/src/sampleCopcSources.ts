import {
  createDefaultCopcCoordinateTransforms,
  createProj4CoordinateTransforms,
  type CopcCoordinateTransformFactory,
} from "copc-cesium";

const EPSG_32611 = "EPSG:32611";

export interface CopcSourceConfig {
  readonly label: string;
  readonly url: string;
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
    url: "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz",
    description: "Public COPC sample using EPSG:2992 coordinates.",
    coordinateTransforms: createDefaultCopcCoordinateTransforms,
  },
  {
    id: "sofi-stadium",
    label: "SoFi Stadium",
    url: "https://s3.amazonaws.com/hobu-lidar/sofi.copc.laz",
    description: "Public COPC sample using WGS84 / UTM zone 11N coordinates.",
    coordinateTransforms: createProj4CoordinateTransforms({
      sourceCrs: EPSG_32611,
      sourceDefinition:
        "+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs",
      label: "EPSG:32611 to WGS84",
    }),
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
