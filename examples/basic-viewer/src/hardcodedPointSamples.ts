import type { PointSample } from "copc-cesium";

export function createHardcodedPointSamples(): PointSample[] {
  return [
    {
      longitudeDegrees: 126.978,
      latitudeDegrees: 37.5665,
      heightMeters: 120,
      color: { red: 255, green: 84, blue: 84 },
    },
    {
      longitudeDegrees: 126.9784,
      latitudeDegrees: 37.5668,
      heightMeters: 145,
      color: { red: 255, green: 180, blue: 64 },
    },
    {
      longitudeDegrees: 126.9775,
      latitudeDegrees: 37.5669,
      heightMeters: 165,
      color: { red: 86, green: 190, blue: 120 },
    },
    {
      longitudeDegrees: 126.9772,
      latitudeDegrees: 37.5663,
      heightMeters: 135,
      color: { red: 80, green: 170, blue: 255 },
    },
    {
      longitudeDegrees: 126.9787,
      latitudeDegrees: 37.5662,
      heightMeters: 155,
      color: { red: 190, green: 120, blue: 255 },
    },
  ];
}
