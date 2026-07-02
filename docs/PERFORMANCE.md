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
budget, moves the Cesium camera, and records `requestAnimationFrame` intervals
plus stream-stage timing.

The result is written to:

```text
output/smoothness-benchmark/smoothness.json
```

Useful overrides:

```powershell
$env:COPC_SMOOTHNESS_SAMPLES="autzen-classified,sofi-stadium"
$env:COPC_SMOOTHNESS_POINT_BUDGETS="2500,5000,10000"
$env:COPC_SMOOTHNESS_REPEATS="5"
$env:COPC_SMOOTHNESS_MIN_SELECTED_DEPTH="2"
npm run benchmark:smoothness
```

The bundled smoothness sample cases expect camera streaming to select at least
depth 2, so a run does not pass just because it fell back to a shallower and
cheaper LOD. `COPC_SMOOTHNESS_MIN_SELECTED_DEPTH` can raise, lower, or disable
that global threshold for local experiments.

## Current Local Result

Measured on 2026-07-01 with the previous point-primitive default:

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

## Renderer Benchmark Checkpoint

Measured on 2026-07-02 with `COPC_BENCHMARK_POINT_COUNT=10000` and
`COPC_BENCHMARK_REPEATS=1`:

| Renderer | Points | Transform | Renderer submit | Total |
| --- | ---: | ---: | ---: | ---: |
| `Primitive typed arrays` | 10,000 | 32.1 ms | 1.1 ms | 33.4 ms |
| `PointPrimitiveCollection` | 10,000 | 45.4 ms | 3.9 ms | 49.6 ms |
| `BufferPointCollection` | 10,000 | 45.8 ms | 11.4 ms | 57.6 ms |

The current default `CesiumPrimitivePointRenderer` submits one typed-array
`Primitive` instead of creating one Cesium point object per point. This checkpoint
shows a CPU submission-time win at 10,000 points. The total render path is still
largely coordinate-transform dominated, so the next performance step should
reduce main-thread coordinate conversion and data preparation overhead.

## Current Default

The basic viewer starts in Balanced detail mode: 120,000 max points per node,
240,000 max Auto LOD points, 120,000 max camera-stream points, and 2 px
typed-array primitive points. The initial load renders one real COPC node to
place the camera, then automatically renders a denser camera-selected coverage
LOD set through depth 3. The stream input acts as a maximum budget: camera
streaming can lower the effective point budget after slow visible updates and
gradually recover it after repeated fast updates. This keeps the demo from
staying overloaded on heavier samples or slower machines.

Additional targeted diagnostics on the SoFi sample with a 2,500-point stream
budget originally measured average stream-stage timing at
expand/select/render/total `234.3/127.2/10.0/470.0 ms`. After limiting Cesium
frustum checks to the requested camera selection depth range, a follow-up run
measured expand/apply/select/render/total
`240.7/105.1/19.0/10.7/375.5 ms`.

After avoiding full node-dropdown rebuilds during camera streaming, the same
targeted check measured expand/apply/select/render/total
`220.2/0.1/0.6/17.1/238.0 ms`, with 60.0 average FPS, 16.80 ms p95 frame time,
and 0 frames over 50 ms.

After moving camera-targeted hierarchy expansion out of the visible stream
update and into a single background prefetch queue, the targeted visible-update
check measured expand/apply/select/render/total
`0.0/0.0/3.0/30.4/33.5 ms`, with 59.4 average FPS, 16.80 ms p95 frame time, and
0 frames over 50 ms.

After allowing camera streaming to select up to two nearby depth-2 nodes, the
same targeted check measured depth avg `2.0`, expand/apply/select/render/total
`0.0/0.0/1.5/17.5/19.0 ms`, with 60.0 average FPS, 16.70 ms p95 frame time,
and 0 frames over 50 ms.

After adding adaptive camera-stream point budgeting, a targeted SoFi run with a
20,000-point maximum stream budget and 2 repeats kept depth avg `2.0` while
lowering the effective render count from 2,668 to 1,000 points after a slow
update. The run measured 59.7 average FPS, 16.80 ms p95 frame time, 33.50 ms
max frame time, and 0 frames over 50 ms. This improves smoothness by sacrificing
temporary point density when the visible stream update is too expensive.

Rendering the submitted points was not the dominant cost in these runs. The
visible camera-stream update is now mostly renderer submission time, while
hierarchy page expansion happens in the background.

The current demo now prioritizes visible COPC coverage more aggressively than
the older smoothness table above: Balanced Auto LOD can select up to 64 coverage
nodes through depth 3, camera streaming can select up to 48 coverage nodes
through depth 3, and Ultra density can target up to 1,000,000 Auto LOD points.
The next performance work should rerun the smoothness benchmark at the new
higher budgets and tune adaptive recovery against these denser defaults.
