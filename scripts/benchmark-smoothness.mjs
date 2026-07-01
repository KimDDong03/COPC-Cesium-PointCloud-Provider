import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(repoRoot, "output");
const benchmarkRoot = path.join(outputRoot, "smoothness-benchmark");
const benchmarkFlowPath = path.join(benchmarkRoot, "smoothness-benchmark-flow.mjs");
const benchmarkResultPath = path.join(benchmarkRoot, "smoothness.json");
const isWindows = process.platform === "win32";
const npmCommand = "npm";
const npxCommand = "npx";
const playwrightCliPackage = "@playwright/cli@0.1.14";
const benchmarkStreamPointBudgets = readPositiveIntegerListEnv(
  "COPC_SMOOTHNESS_POINT_BUDGETS",
  [2_500, 5_000, 10_000, 20_000],
);
const smoothnessSampleCaseById = {
  "autzen-classified": {
    id: "autzen-classified",
    label: "Autzen classified",
    kind: "preset",
    sampleId: "autzen-classified",
    expectedSourcePreset: "Autzen classified",
    expectedCoordinateTransformText: "EPSG:2992",
    expectedMinSelectedDepth: 2,
  },
  "sofi-stadium": {
    id: "sofi-stadium",
    label: "SoFi Stadium",
    kind: "preset",
    sampleId: "sofi-stadium",
    expectedSourcePreset: "SoFi Stadium",
    expectedCoordinateTransformText: "EPSG:32611",
    expectedMinSelectedDepth: 2,
  },
  "custom-sofi": {
    id: "custom-sofi",
    label: "Custom SoFi URL",
    kind: "custom",
    url: "https://s3.amazonaws.com/hobu-lidar/sofi.copc.laz",
    sourceCrs: "EPSG:32611",
    sourceDefinition:
      "+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs",
    expectedSourcePreset: "Custom URL",
    expectedCoordinateTransformText: "EPSG:32611 to EPSG:4326",
    expectedMinSelectedDepth: 2,
  },
};
const benchmarkSampleCases = readSampleCasesEnv(
  "COPC_SMOOTHNESS_SAMPLES",
  ["autzen-classified", "sofi-stadium", "custom-sofi"],
);
const benchmarkMaxPointCountPerNode = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_POINT_COUNT",
  Math.max(...benchmarkStreamPointBudgets),
);
const benchmarkRepeats = readPositiveIntegerEnv("COPC_SMOOTHNESS_REPEATS", 2);
const benchmarkDurationMilliseconds = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_DURATION_MS",
  3000,
);
const benchmarkCameraSteps = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_CAMERA_STEPS",
  24,
);
const benchmarkMoveMeters = readPositiveIntegerEnv(
  "COPC_SMOOTHNESS_MOVE_METERS",
  25,
);
const benchmarkMinSelectedDepthOverride = readNonNegativeIntegerEnv(
  "COPC_SMOOTHNESS_MIN_SELECTED_DEPTH",
  undefined,
);

if (benchmarkMaxPointCountPerNode < Math.max(...benchmarkStreamPointBudgets)) {
  throw new Error(
    "COPC_SMOOTHNESS_POINT_COUNT must be greater than or equal to every COPC_SMOOTHNESS_POINT_BUDGETS value.",
  );
}

function readPositiveIntegerEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return value;
}

function readPositiveIntegerListEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const values = rawValue
    .split(",")
    .map((value) => Number(value.trim()))
    .filter((value) => value !== 0);

  if (
    values.length === 0 ||
    values.some((value) => !Number.isSafeInteger(value) || value <= 0)
  ) {
    throw new Error(`${name} must be a comma-separated list of positive integers.`);
  }

  return [...new Set(values)];
}

function readNonNegativeIntegerEnv(name, fallback) {
  const rawValue = process.env[name];

  if (!rawValue) {
    return fallback;
  }

  const value = Number(rawValue);

  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer.`);
  }

  return value;
}

function readSampleCasesEnv(name, fallbackIds) {
  const rawValue = process.env[name];
  const ids = rawValue
    ? rawValue
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean)
    : fallbackIds;
  const uniqueIds = [...new Set(ids)];
  const unknownIds = uniqueIds.filter((id) => !(id in smoothnessSampleCaseById));

  if (unknownIds.length > 0) {
    throw new Error(
      `${name} contains unknown sample ids: ${unknownIds.join(", ")}`,
    );
  }

  return uniqueIds.map((id) => smoothnessSampleCaseById[id]);
}

function assertInside(parent, target) {
  const relative = path.relative(parent, target);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to operate outside ${parent}: ${target}`);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: isWindows,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }
}

function runPlaywrightCli(args) {
  const result = spawnSync(
    npxCommand,
    ["--yes", "--package", playwrightCliPackage, "playwright-cli", ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      shell: isWindows,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `playwright-cli ${args.join(" ")} failed with exit code ${result.status}`,
    );
  }

  if (`${result.stdout}\n${result.stderr}`.includes("### Error")) {
    throw new Error(`playwright-cli ${args.join(" ")} reported an error`);
  }

  return `${result.stdout}\n${result.stderr}`;
}

function extractPlaywrightResult(output) {
  const marker = "### Result";
  const markerIndex = output.lastIndexOf(marker);

  if (markerIndex === -1) {
    throw new Error("Could not find Playwright result output.");
  }

  const outputAfterMarker = output.slice(markerIndex + marker.length);
  const jsonStart = outputAfterMarker.search(/[\[{]/);

  if (jsonStart === -1) {
    throw new Error("Could not find Playwright result JSON.");
  }

  const jsonText = outputAfterMarker.slice(jsonStart);
  let depth = 0;
  let isInsideString = false;
  let isEscaped = false;

  for (let index = 0; index < jsonText.length; index += 1) {
    const character = jsonText[index];

    if (isInsideString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (character === "\\") {
        isEscaped = true;
      } else if (character === "\"") {
        isInsideString = false;
      }

      continue;
    }

    if (character === "\"") {
      isInsideString = true;
      continue;
    }

    if (character === "{" || character === "[") {
      depth += 1;
      continue;
    }

    if (character === "}" || character === "]") {
      depth -= 1;

      if (depth === 0) {
        return JSON.parse(jsonText.slice(0, index + 1));
      }
    }
  }

  throw new Error("Could not parse complete Playwright result JSON.");
}

async function findAvailablePort(startPort) {
  for (let port = startPort; port < startPort + 50; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }

  throw new Error(`No available preview port found from ${startPort}.`);
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "localhost");
  });
}

async function waitForServer(url, serverProcess, serverOutput) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(
        `Example preview server exited early with code ${serverProcess.exitCode}.\n${serverOutput.join("")}`,
      );
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(1_000),
      });

      if (response.ok) {
        return;
      }
    } catch {
      // Retry until the Vite preview server starts listening.
    }

    await delay(500);
  }

  throw new Error(`Timed out waiting for example preview server: ${url}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stopServer(serverProcess) {
  if (!serverProcess.pid || serverProcess.exitCode !== null) {
    return;
  }

  if (isWindows) {
    spawnSync("taskkill", ["/pid", String(serverProcess.pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }

  serverProcess.kill("SIGTERM");
}

function createSmoothnessFlow(
  baseUrl,
  maxPointCountPerNode,
  streamPointBudgets,
  sampleCases,
  repeatCount,
  durationMilliseconds,
  cameraSteps,
  moveMeters,
  minSelectedDepthOverride,
) {
  return `async (page) => {
  const maxPointCountPerNode = ${JSON.stringify(maxPointCountPerNode)};
  const streamPointBudgets = ${JSON.stringify(streamPointBudgets)};
  const sampleCases = ${JSON.stringify(sampleCases)};
  const repeatCount = ${JSON.stringify(repeatCount)};
  const durationMilliseconds = ${JSON.stringify(durationMilliseconds)};
  const cameraSteps = ${JSON.stringify(cameraSteps)};
  const moveMeters = ${JSON.stringify(moveMeters)};
  const minSelectedDepthOverride = ${JSON.stringify(minSelectedDepthOverride)};
  const failures = [];
  const consoleProblems = [];
  const pageErrors = [];
  const results = [];

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleProblems.push(\`\${message.type()}: \${message.text()}\`);
    }
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  async function metadataValue(label) {
    return page.evaluate((targetLabel) => {
      const rows = [...document.querySelectorAll("#copc-metadata dt")];
      return rows.find((row) => row.textContent === targetLabel)
        ?.nextElementSibling?.textContent;
    }, label);
  }

  async function waitForRenderedStatus() {
    try {
      await page.waitForFunction(
        () => document.querySelector("#copc-status")?.textContent?.includes("Rendered "),
        undefined,
        { timeout: 120_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        \`Timed out waiting for a rendered status. Current status: "\${currentStatus}". \${error.message}\`,
      );
    }
  }

  async function waitForCameraStreamStatus() {
    try {
      await page.waitForFunction(
        () => document.querySelector("#copc-status")?.textContent?.includes("Camera stream rendered"),
        undefined,
        { timeout: 120_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        \`Timed out waiting for a camera stream render. Current status: "\${currentStatus}". \${error.message}\`,
      );
    }
  }

  async function benchmarkStatus() {
    return page.evaluate(() => {
      const benchmark = window.__copcBasicViewerBenchmark;

      if (!benchmark) {
        throw new Error("Basic viewer benchmark API was not installed.");
      }

      return benchmark.getStatus();
    });
  }

  async function prepareViewer(sampleCase, initialStreamPointBudget) {
    await page.evaluate(({ maxPointCountPerNode, sampleCase, initialStreamPointBudget }) => {
      const sampleSelect = document.querySelector("#copc-sample-select");
      const rendererSelect = document.querySelector("#copc-renderer-select");
      const maxPointCountInput = document.querySelector("#copc-max-point-count");
      const streamPointBudgetInput = document.querySelector(
        "#copc-camera-stream-point-budget",
      );
      const urlInput = document.querySelector("#copc-url");
      const sourceCrsInput = document.querySelector("#copc-source-crs");
      const sourceDefinitionInput = document.querySelector("#copc-source-definition");
      const checkbox = document.querySelector("#copc-auto-stream");
      const form = document.querySelector("#copc-form");
      const status = document.querySelector("#copc-status");

      if (!(sampleSelect instanceof HTMLSelectElement)) {
        throw new Error("Sample select was not found.");
      }

      if (!(rendererSelect instanceof HTMLSelectElement)) {
        throw new Error("Renderer select was not found.");
      }

      if (!(maxPointCountInput instanceof HTMLInputElement)) {
        throw new Error("Max point count input was not found.");
      }

      if (!(streamPointBudgetInput instanceof HTMLInputElement)) {
        throw new Error("Camera stream point budget input was not found.");
      }

      if (!(urlInput instanceof HTMLInputElement)) {
        throw new Error("COPC URL input was not found.");
      }

      if (!(sourceCrsInput instanceof HTMLInputElement)) {
        throw new Error("Source CRS input was not found.");
      }

      if (!(sourceDefinitionInput instanceof HTMLTextAreaElement)) {
        throw new Error("Source definition input was not found.");
      }

      if (!(checkbox instanceof HTMLInputElement)) {
        throw new Error("Stream on camera move checkbox was not found.");
      }

      if (!(form instanceof HTMLFormElement)) {
        throw new Error("COPC form was not found.");
      }

      if (checkbox.checked) {
        checkbox.checked = false;
        checkbox.dispatchEvent(new Event("change", { bubbles: true }));
      }

      rendererSelect.value = "primitive";
      maxPointCountInput.value = String(maxPointCountPerNode);
      streamPointBudgetInput.value = String(initialStreamPointBudget);

      if (status) {
        status.textContent = "Smoothness benchmark render pending...";
      }

      if (sampleCase.kind === "preset") {
        sampleSelect.value = sampleCase.sampleId;
        sampleSelect.dispatchEvent(new Event("change", { bubbles: true }));
        return;
      }

      sampleSelect.value = "custom";
      sampleSelect.dispatchEvent(new Event("change", { bubbles: true }));
      urlInput.value = sampleCase.url;
      sourceCrsInput.value = sampleCase.sourceCrs ?? "";
      sourceDefinitionInput.value = sampleCase.sourceDefinition ?? "";
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    }, { maxPointCountPerNode, sampleCase, initialStreamPointBudget });
    await waitForRenderedStatus();

    const loadedSourcePreset = await metadataValue("Source preset");
    const loadedCoordinateTransform = await metadataValue("Coordinate transform");

    if (loadedSourcePreset !== sampleCase.expectedSourcePreset) {
      failures.push(
        \`\${sampleCase.id} loaded unexpected source preset: \${loadedSourcePreset}\`,
      );
    }

    if (!loadedCoordinateTransform?.includes(sampleCase.expectedCoordinateTransformText)) {
      failures.push(
        \`\${sampleCase.id} loaded unexpected coordinate transform: \${loadedCoordinateTransform}\`,
      );
    }

    await page.evaluate(() => {
      const checkbox = document.querySelector("#copc-auto-stream");
      const status = document.querySelector("#copc-status");

      if (!(checkbox instanceof HTMLInputElement)) {
        throw new Error("Stream on camera move checkbox was not found.");
      }

      if (checkbox.disabled) {
        throw new Error("Stream on camera move is disabled.");
      }

      if (status) {
        status.textContent = "Smoothness benchmark camera stream pending...";
      }

      if (!checkbox.checked) {
        checkbox.checked = true;
      }

      checkbox.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitForCameraStreamStatus();

    return {
      sampleId: sampleCase.id,
      label: sampleCase.label,
      sourcePreset: loadedSourcePreset,
      coordinateTransform: loadedCoordinateTransform,
      pointRenderer: await metadataValue("Point renderer"),
      expectedMinSelectedDepth: sampleCase.expectedMinSelectedDepth,
    };
  }

  async function setStreamPointBudget(streamPointBudget) {
    await page.evaluate((streamPointBudget) => {
      const input = document.querySelector("#copc-camera-stream-point-budget");
      const status = document.querySelector("#copc-status");

      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Camera stream point budget input was not found.");
      }

      input.value = String(streamPointBudget);

      if (status) {
        status.textContent = "Smoothness benchmark stream budget pending...";
      }

      input.dispatchEvent(new Event("change", { bubbles: true }));
    }, streamPointBudget);
    await waitForCameraStreamStatus();
  }

  function average(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function percentile(values, ratio) {
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.max(0, Math.ceil(sorted.length * ratio) - 1);
    return sorted[index] ?? 0;
  }

  function summarizeFrames(frameDeltas) {
    return {
      frameCount: frameDeltas.length,
      averageFrameMilliseconds: average(frameDeltas),
      medianFrameMilliseconds: percentile(frameDeltas, 0.5),
      p95FrameMilliseconds: percentile(frameDeltas, 0.95),
      maxFrameMilliseconds: Math.max(...frameDeltas),
      estimatedAverageFps: 1000 / average(frameDeltas),
      frameDeltasOver50Milliseconds: frameDeltas.filter((delta) => delta > 50).length,
      frameDeltasOver100Milliseconds: frameDeltas.filter((delta) => delta > 100).length,
    };
  }

  function parseCameraStreamPointCount(statusText) {
    const match = statusText.match(/Camera stream rendered ([\\d,]+) points/);

    if (!match) {
      return undefined;
    }

    return Number(match[1].replaceAll(",", ""));
  }

  function parseCameraStreamDiagnostics(diagnosticsText) {
    const match = diagnosticsText?.match(
      /^expand ([\\d,.]+) ms, apply ([\\d,.]+) ms, select ([\\d,.]+) ms, render ([\\d,.]+) ms, total ([\\d,.]+) ms, ([\\d,]+) pages, ([\\d,]+) nodes, depth ([\\d,]+)$/,
    );

    if (!match) {
      return undefined;
    }

    return {
      expandHierarchyMilliseconds: Number(match[1].replaceAll(",", "")),
      applyHierarchyMilliseconds: Number(match[2].replaceAll(",", "")),
      selectNodesMilliseconds: Number(match[3].replaceAll(",", "")),
      renderNodesMilliseconds: Number(match[4].replaceAll(",", "")),
      totalMilliseconds: Number(match[5].replaceAll(",", "")),
      loadedHierarchyPageCount: Number(match[6].replaceAll(",", "")),
      selectedNodeCount: Number(match[7].replaceAll(",", "")),
      selectedDepth: Number(match[8].replaceAll(",", "")),
    };
  }

  function parseAppliedCameraStreamBudget(budgetText) {
    const lastMatch = budgetText?.match(/last ([\\d,]+) points/);

    if (lastMatch) {
      return Number(lastMatch[1].replaceAll(",", ""));
    }

    const budgetMatch = budgetText?.match(/^([\\d,]+) points/);

    return budgetMatch ? Number(budgetMatch[1].replaceAll(",", "")) : undefined;
  }

  async function measureSmoothness(sampleSnapshot, streamPointBudget, runIndex) {
    const measurement = await page.evaluate(
      async ({ durationMilliseconds, cameraSteps, moveMeters }) => {
        const benchmark = window.__copcBasicViewerBenchmark;

        if (!benchmark) {
          throw new Error("Basic viewer benchmark API was not installed.");
        }

        const frameDeltas = [];
        let previousFrameTimestamp;
        let isRunning = true;

        function onFrame(timestamp) {
          if (previousFrameTimestamp !== undefined) {
            frameDeltas.push(timestamp - previousFrameTimestamp);
          }

          previousFrameTimestamp = timestamp;

          if (isRunning) {
            window.requestAnimationFrame(onFrame);
          }
        }

        window.requestAnimationFrame(onFrame);
        const startedAt = performance.now();
        const status = await benchmark.moveCameraForSmoothness({
          steps: cameraSteps,
          durationMilliseconds,
          moveMeters,
        });
        const completedAt = performance.now();
        await new Promise((resolve) => {
          window.requestAnimationFrame(() => {
            isRunning = false;
            resolve(undefined);
          });
        });

        return {
          measuredDurationMilliseconds: completedAt - startedAt,
          frameDeltas,
          status,
        };
      },
      { durationMilliseconds, cameraSteps, moveMeters },
    );

    if (!measurement.status.status.includes("Camera stream rendered")) {
      await waitForCameraStreamStatus();
      measurement.status = await benchmarkStatus();
    }

    if (measurement.frameDeltas.length < Math.max(10, cameraSteps / 2)) {
      failures.push(
        \`run \${runIndex} collected only \${measurement.frameDeltas.length} frames during camera movement.\`,
      );
    }

    if (!measurement.status.status.includes("Camera stream rendered")) {
      failures.push(
        \`run \${runIndex} ended with unexpected status: \${measurement.status.status}\`,
      );
    }

    if (!measurement.status.rendererTiming || measurement.status.rendererTiming.includes("Not rendered")) {
      failures.push(\`run \${runIndex} did not expose renderer timing after camera movement.\`);
    }

    const renderedPointCount = parseCameraStreamPointCount(measurement.status.status);
    const cameraStreamDiagnostics = parseCameraStreamDiagnostics(
      measurement.status.cameraStreamDiagnostics,
    );
    const appliedStreamPointBudget =
      parseAppliedCameraStreamBudget(measurement.status.cameraStreamBudget) ??
      streamPointBudget;

    if (renderedPointCount === undefined) {
      failures.push(\`run \${runIndex} did not report a camera stream point count.\`);
    } else if (renderedPointCount > appliedStreamPointBudget) {
      failures.push(
        \`run \${runIndex} rendered \${renderedPointCount} points with a \${appliedStreamPointBudget} point budget.\`,
      );
    }

    if (!cameraStreamDiagnostics) {
      failures.push(\`run \${runIndex} did not expose camera stream diagnostics.\`);
    } else {
      const expectedMinSelectedDepth =
        minSelectedDepthOverride ?? sampleSnapshot.expectedMinSelectedDepth;

      if (
        expectedMinSelectedDepth !== undefined &&
        cameraStreamDiagnostics.selectedDepth < expectedMinSelectedDepth
      ) {
        failures.push(
          \`run \${runIndex} selected depth \${cameraStreamDiagnostics.selectedDepth}; expected at least \${expectedMinSelectedDepth}.\`,
        );
      }
    }

    return {
      sampleId: sampleSnapshot.sampleId,
      sampleLabel: sampleSnapshot.label,
      sourcePreset: sampleSnapshot.sourcePreset,
      coordinateTransform: sampleSnapshot.coordinateTransform,
      runIndex,
      streamPointBudget,
      renderedPointCount,
      cameraStreamDiagnosticsText: measurement.status.cameraStreamDiagnostics,
      cameraStreamDiagnostics,
      ...measurement,
      summary: summarizeFrames(measurement.frameDeltas),
    };
  }

  await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: "domcontentloaded" });
  await waitForRenderedStatus();

  for (const sampleCase of sampleCases) {
    const sampleSnapshot = await prepareViewer(sampleCase, streamPointBudgets[0]);

    for (const streamPointBudget of streamPointBudgets) {
      await setStreamPointBudget(streamPointBudget);

      for (let runIndex = 1; runIndex <= repeatCount; runIndex += 1) {
        results.push(
          await measureSmoothness(sampleSnapshot, streamPointBudget, runIndex),
        );
      }
    }
  }

  if (consoleProblems.length > 0 || pageErrors.length > 0) {
    failures.push(
      [
        ...consoleProblems.map((message) => \`console \${message}\`),
        ...pageErrors.map((message) => \`pageerror: \${message}\`),
      ].join("\\n"),
    );
  }

  if (failures.length > 0) {
    throw new Error(failures.join("\\n"));
  }

  return {
    maxPointCountPerNode,
    streamPointBudgets,
    sampleCases: sampleCases.map((sampleCase) => ({
      id: sampleCase.id,
      label: sampleCase.label,
      kind: sampleCase.kind,
      expectedMinSelectedDepth:
        minSelectedDepthOverride ?? sampleCase.expectedMinSelectedDepth,
    })),
    repeatCount,
    durationMilliseconds,
    cameraSteps,
    moveMeters,
    pointRenderer: await metadataValue("Point renderer"),
    results,
  };
}
`;
}

function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function printBenchmarkSummary(result) {
  console.log("Smoothness benchmark summary:");

  console.log(
    `- ${result.maxPointCountPerNode.toLocaleString()} max points / node, ${result.cameraSteps.toLocaleString()} camera steps`,
  );

  for (const sampleCase of result.sampleCases) {
    const depthTarget =
      sampleCase.expectedMinSelectedDepth === undefined
        ? ""
        : `, min selected depth ${sampleCase.expectedMinSelectedDepth}`;
    console.log(`- ${sampleCase.label}${depthTarget}`);

    for (const streamPointBudget of result.streamPointBudgets) {
      const runs = result.results.filter(
        (run) =>
          run.sampleId === sampleCase.id &&
          run.streamPointBudget === streamPointBudget,
      );

      if (runs.length === 0) {
        console.log(
          `  - ${streamPointBudget.toLocaleString()} point stream budget: no runs`,
        );
        continue;
      }

      const averageFps = average(
        runs.map((run) => run.summary.estimatedAverageFps),
      );
      const averageP95 = average(
        runs.map((run) => run.summary.p95FrameMilliseconds),
      );
      const maxFrame = Math.max(
        ...runs.map((run) => run.summary.maxFrameMilliseconds),
      );
      const over50 = runs.reduce(
        (sum, run) => sum + run.summary.frameDeltasOver50Milliseconds,
        0,
      );
      const renderedPoints = runs.map((run) => run.renderedPointCount ?? 0);
      const diagnostics = runs
        .map((run) => run.cameraStreamDiagnostics)
        .filter(Boolean);
      const averageExpandMilliseconds = average(
        diagnostics.map((run) => run.expandHierarchyMilliseconds),
      );
      const averageApplyMilliseconds = average(
        diagnostics.map((run) => run.applyHierarchyMilliseconds),
      );
      const averageSelectMilliseconds = average(
        diagnostics.map((run) => run.selectNodesMilliseconds),
      );
      const averageRenderMilliseconds = average(
        diagnostics.map((run) => run.renderNodesMilliseconds),
      );
      const averageTotalStreamMilliseconds = average(
        diagnostics.map((run) => run.totalMilliseconds),
      );
      const averageSelectedDepth = average(
        diagnostics.map((run) => run.selectedDepth),
      );

      console.log(
        [
          `  - ${streamPointBudget.toLocaleString()} point stream budget`,
          `${runs.length.toLocaleString()} runs`,
          `${Math.min(...renderedPoints).toLocaleString()}-${Math.max(...renderedPoints).toLocaleString()} rendered pts`,
          `avg ${averageFps.toFixed(1)} fps`,
          `p95 ${averageP95.toFixed(2)} ms`,
          `max ${maxFrame.toFixed(2)} ms`,
          `${over50.toLocaleString()} frames > 50 ms`,
          `depth avg ${averageSelectedDepth.toFixed(1)}`,
          `stream avg expand/apply/select/render/total ${averageExpandMilliseconds.toFixed(1)}/${averageApplyMilliseconds.toFixed(1)}/${averageSelectMilliseconds.toFixed(1)}/${averageRenderMilliseconds.toFixed(1)}/${averageTotalStreamMilliseconds.toFixed(1)} ms`,
        ].join(", "),
      );
    }
  }
}

await mkdir(outputRoot, { recursive: true });
assertInside(outputRoot, benchmarkRoot);
await rm(benchmarkRoot, { recursive: true, force: true });
await mkdir(benchmarkRoot, { recursive: true });

console.log("Building example...");
run(npmCommand, ["run", "build:example"], repoRoot);

const port = await findAvailablePort(4373);
const baseUrl = `http://localhost:${port}`;
const serverOutput = [];
const serverProcess = spawn(
  npxCommand,
  [
    "vite",
    "preview",
    "examples/basic-viewer",
    "--config",
    "vite.config.ts",
    "--host",
    "localhost",
    "--port",
    String(port),
    "--strictPort",
    "--outDir",
    "../../dist/example",
  ],
  {
    cwd: repoRoot,
    shell: isWindows,
    stdio: ["ignore", "pipe", "pipe"],
  },
);

serverProcess.stdout.on("data", (data) => {
  serverOutput.push(data.toString());
});
serverProcess.stderr.on("data", (data) => {
  serverOutput.push(data.toString());
});

try {
  console.log(`Starting example preview at ${baseUrl}...`);
  await waitForServer(baseUrl, serverProcess, serverOutput);

  await writeFile(
    benchmarkFlowPath,
    createSmoothnessFlow(
      baseUrl,
      benchmarkMaxPointCountPerNode,
      benchmarkStreamPointBudgets,
      benchmarkSampleCases,
      benchmarkRepeats,
      benchmarkDurationMilliseconds,
      benchmarkCameraSteps,
      benchmarkMoveMeters,
      benchmarkMinSelectedDepthOverride,
    ),
  );

  console.log(
    [
      "Running smoothness benchmark:",
      `${benchmarkMaxPointCountPerNode.toLocaleString()} max points / node,`,
      `${benchmarkStreamPointBudgets
        .map((value) => value.toLocaleString())
        .join("/")} stream budgets,`,
      `${benchmarkSampleCases.map((sample) => sample.id).join("/")} samples,`,
      `${benchmarkRepeats.toLocaleString()} repeats,`,
      `${benchmarkCameraSteps.toLocaleString()} camera steps,`,
      benchmarkMinSelectedDepthOverride === undefined
        ? "sample depth targets"
        : `min selected depth ${benchmarkMinSelectedDepthOverride}`,
    ].join(" "),
  );
  runPlaywrightCli(["open", "about:blank"]);
  const output = runPlaywrightCli(["run-code", "--filename", benchmarkFlowPath]);
  const result = extractPlaywrightResult(output);
  await writeFile(benchmarkResultPath, `${JSON.stringify(result, null, 2)}\n`);
  printBenchmarkSummary(result);
  console.log(`Smoothness benchmark result written: ${benchmarkResultPath}`);
} finally {
  try {
    runPlaywrightCli(["close"]);
  } catch {
    // The browser may already be closed if startup failed.
  }
  stopServer(serverProcess);
}
