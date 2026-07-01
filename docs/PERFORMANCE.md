# Performance Notes

`copc-cesium` is still a prototype, so performance claims should be backed by
repeatable browser measurements instead of fixed guarantees.

## Smoothness Benchmark

Run:

```bash
npm run benchmark:smoothness
```

The benchmark builds the basic viewer, opens each configured COPC sample in a
real browser, enables `Stream on camera move`, changes the camera-stream point
budget, moves the Cesium camera, and records `requestAnimationFrame` intervals.

The result is written to:

```text
output/smoothness-benchmark/smoothness.json
```

Useful overrides:

```powershell
$env:COPC_SMOOTHNESS_SAMPLES="autzen-classified,sofi-stadium"
$env:COPC_SMOOTHNESS_POINT_BUDGETS="2500,5000,10000"
$env:COPC_SMOOTHNESS_REPEATS="5"
npm run benchmark:smoothness
```

## Current Local Result

Measured on 2026-07-01 with:

- Sources: Autzen classified, SoFi Stadium, Custom SoFi URL
- Renderer: `PointPrimitiveCollection`
- Max points / node: 20,000
- Camera steps: 24
- Repeats: 2 per budget

| Sample | Camera stream budget | Rendered points | Avg FPS | p95 frame | Max frame | Frames > 50 ms |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Autzen classified | 2,500 | 2,500 | 59.1 | 16.80 ms | 50.10 ms | 1 |
| Autzen classified | 5,000 | 5,000 | 58.8 | 16.80 ms | 66.60 ms | 1 |
| Autzen classified | 10,000 | 10,000 | 53.9 | 33.30 ms | 100.10 ms | 2 |
| Autzen classified | 20,000 | 20,000 | 44.9 | 33.40 ms | 133.30 ms | 2 |
| SoFi Stadium | 2,500 | 2,500 | 36.6 | 174.95 ms | 250.00 ms | 26 |
| SoFi Stadium | 5,000 | 5,000 | 28.9 | 300.00 ms | 433.40 ms | 25 |
| SoFi Stadium | 10,000 | 10,000 | 19.0 | 441.65 ms | 616.80 ms | 25 |
| SoFi Stadium | 20,000 | 20,000 | 21.8 | 416.60 ms | 616.70 ms | 23 |
| Custom SoFi URL | 2,500 | 2,500 | 36.5 | 166.70 ms | 266.70 ms | 25 |
| Custom SoFi URL | 5,000 | 5,000 | 23.1 | 358.30 ms | 533.30 ms | 26 |
| Custom SoFi URL | 10,000 | 10,000 | 19.6 | 424.95 ms | 600.00 ms | 27 |
| Custom SoFi URL | 20,000 | 20,000 | 15.6 | 449.95 ms | 533.40 ms | 34 |

## Current Default

The basic viewer keeps the camera-stream point budget at 5,000 points by
default. In the current local benchmark it was reasonable for the Autzen sample,
but SoFi still produced long frames even at 2,500 points.

Additional targeted diagnostics on the SoFi sample with a 2,500-point stream
budget measured average stream-stage timing at expand/select/render/total
`234.3/127.2/10.0/470.0 ms`. Rendering the submitted points was not the dominant
cost in that run; hierarchy expansion, hierarchy application, and node selection
were the larger sources of delay.

This means the next performance work should focus on camera-stream scheduling
and hierarchy expansion cost, not simply lowering the render point count. 10,000
and 20,000 points are currently best treated as stress cases, not defaults.
