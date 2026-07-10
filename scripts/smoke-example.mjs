import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(repoRoot, "output");
const smokeRoot = path.join(outputRoot, "example-smoke");
const localFileSampleRoot = path.join(outputRoot, "local-copc-samples");
const screenshotDir = path.join(outputRoot, "playwright");
const smokeFlowPath = path.join(smokeRoot, "smoke-example-flow.mjs");
const autzenScreenshotPath = path.join(
  screenshotDir,
  "smoke-example-autzen-stream.png",
);
const screenshotPath = path.join(screenshotDir, "smoke-example-sofi-stream.png");
const verificationScreenshotPath = path.join(
  screenshotDir,
  "smoke-example-final-verification.png",
);
const playwrightConfigPath = path.join(
  scriptDir,
  "playwright.high-performance-gpu.json",
);
const localFileSampleUrl =
  "https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz";
const localFileSamplePath = path.join(
  localFileSampleRoot,
  "autzen-classified.copc.laz",
);
const isWindows = process.platform === "win32";
const npmCommand = "npm";
const npxCommand = "npx";
const playwrightCliPackage = "@playwright/cli@0.1.14";
const shouldRunLocalFileSmoke =
  process.argv.includes("--local-file") ||
  process.env.COPC_SMOKE_LOCAL_FILE === "1";

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

function createSmokeFlow(baseUrl) {
  const localFilePath = shouldRunLocalFileSmoke
    ? JSON.stringify(localFileSamplePath)
    : "undefined";

  return `async (page) => {
  const failures = [];
  const consoleProblems = [];
  const pageErrors = [];

  page.on("console", (message) => {
    if (message.type() === "error" || message.type() === "warning") {
      consoleProblems.push(\`\${message.type()}: \${message.text()}\`);
    }
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  const expectedRenderedStatuses = [
    "Camera stream rendered",
    "Camera stream previewed",
    "Camera stream partial render",
    "Auto LOD rendered",
  ];
  const minDefaultInteractivePointCount = 4_000;
  const sofiUrl = ${JSON.stringify(`${baseUrl}/copc-samples/sofi.copc.laz`)};
  const sofiDefinition =
    "+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs";
  const localFilePath = ${localFilePath};
  let primitiveRendererTiming = "";
  let primitiveRendererPayload = "";
  let typedRendererTiming = "";
  let typedRendererPayload = "";
  let typedPointGeometryTiming = "";
  let typedPointGeometryCache = "";
  let localFileRendererTiming = "";
  let cameraStreamControllerSmoke;
  let browserGraphics;

  async function readBrowserGraphics() {
    return page.evaluate(() => {
      const canvas = document.createElement("canvas");
      const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");

      if (!context) {
        throw new Error("WebGL is unavailable in the browser smoke test.");
      }

      const debugInfo = context.getExtension("WEBGL_debug_renderer_info");

      return {
        vendor: debugInfo
          ? context.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)
          : context.getParameter(context.VENDOR),
        renderer: debugInfo
          ? context.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL)
          : context.getParameter(context.RENDERER),
        version: context.getParameter(context.VERSION),
      };
    });
  }

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
        (statusTexts) => {
          const currentStatus =
            document.querySelector("#copc-status")?.textContent ?? "";
          return statusTexts.some((statusText) =>
            currentStatus.includes(statusText),
          );
        },
        expectedRenderedStatuses,
        { timeout: 60_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        "Timed out waiting for a rendered status. Current status: " +
          '"' +
          currentStatus +
          '". ' +
          error.message,
      );
    }
  }

  async function waitForCameraStreamCompleteStatus() {
    try {
      await page.waitForFunction(
        () =>
          document
            .querySelector("#copc-status")
            ?.textContent?.includes("Camera stream rendered"),
        undefined,
        { timeout: 120_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        \`Timed out waiting for camera-stream completion. Current status: "\${currentStatus}". \${error.message}\`,
      );
    }
  }

  async function waitForSceneReady() {
    await page.evaluate(async () => {
      const benchmark = window.__copcBasicViewerBenchmark;

      if (!benchmark) {
        throw new Error("Basic viewer benchmark API was not installed.");
      }

      await benchmark.waitForSceneReady();
    });
  }

  async function waitForInteractivePointCount(minPointCount) {
    try {
      await page.waitForFunction(
        ({ minPointCount, statusTexts }) => {
          const currentStatus =
            document.querySelector("#copc-status")?.textContent ?? "";
          const rows = [...document.querySelectorAll("#copc-metadata dt")];
          const rendererTiming =
            rows.find((row) => row.textContent === "Renderer timing")
              ?.nextElementSibling?.textContent ?? "";
          const pointCountText = currentStatus + " " + rendererTiming;
          const match = pointCountText.match(
            /(?:rendered\\s+|previewed\\s+)?([\\d,]+)\\s+(?:pts|points)/i,
          );
          const pointCount = match
            ? Number(match[1].replaceAll(",", ""))
            : 0;

          return (
            statusTexts.some((statusText) => currentStatus.includes(statusText)) &&
            pointCount >= minPointCount
          );
        },
        { minPointCount, statusTexts: expectedRenderedStatuses },
        { timeout: 120_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      const rendererTiming = await metadataValue("Renderer timing");
      throw new Error(
        \`Timed out waiting for the example to display at least \${minPointCount.toLocaleString()} interactive points. Current status: "\${currentStatus}". Renderer timing: "\${rendererTiming}". \${error.message}\`,
      );
    }
  }

  function isRenderedStatus(statusText) {
    return expectedRenderedStatuses.some((expectedStatus) =>
      statusText.includes(expectedStatus),
    );
  }

  function parsePointCount(text) {
    const match = text.match(/(?:rendered\\s+)?([\\d,]+)\\s+(?:pts|points)/i);

    return match ? Number(match[1].replaceAll(",", "")) : 0;
  }

  async function check(condition, message) {
    if (!(await condition())) {
      failures.push(message);
    }
  }

  await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: "domcontentloaded" });
  browserGraphics = await readBrowserGraphics();
  await waitForInteractivePointCount(minDefaultInteractivePointCount);
  await check(
    async () =>
      (await page.title()) ===
      "copc-cesium | Direct COPC streaming for CesiumJS",
    "Example page title did not identify the copc-cesium library.",
  );

  await check(
    async () => (await metadataValue("Source preset")) === "Autzen classified",
    "Autzen preset did not load as the initial source.",
  );
  await check(
    async () =>
      (await metadataValue("Coordinate transform"))?.includes("EPSG:2992"),
    "Autzen coordinate transform was not reported.",
  );
  await check(
    async () =>
      (await metadataValue("Point renderer")) ===
      "Primitive typed arrays",
    "Default typed-array primitive renderer was not reported.",
  );
  typedRendererTiming = (await metadataValue("Renderer timing")) ?? "";
  typedRendererPayload = (await metadataValue("Renderer payload")) ?? "";
  typedPointGeometryTiming =
    (await metadataValue("Point geometry timing")) ?? "";
  typedPointGeometryCache =
    (await metadataValue("Point geometry cache")) ?? "";
  await check(
    async () => parsePointCount(typedRendererTiming) >= minDefaultInteractivePointCount,
    "Default renderer timing did not report the expected interactive point count.",
  );
  await check(
    async () => typedRendererPayload.includes("estimated coordinate/color payload"),
    "Default renderer payload estimate was not reported.",
  );
  await check(
    async () =>
      typedPointGeometryTiming === "Not available" ||
      (
        typedPointGeometryTiming.includes("decode") &&
        typedPointGeometryTiming.includes("worker") &&
        typedPointGeometryTiming.includes("slowest")
      ),
    "Default point geometry timing metadata was not reported.",
  );
  await check(
    async () =>
      typedPointGeometryCache.includes("loaded batches") &&
      typedPointGeometryCache.includes("density reuses"),
    "Default point geometry cache stats were not reported.",
  );
  await check(
    async () => page.locator("#copc-source-crs").isDisabled(),
    "Projection controls should be disabled for sample presets.",
  );

  cameraStreamControllerSmoke = await page.evaluate(async () => {
    const benchmark = window.__copcBasicViewerBenchmark;

    if (!benchmark) {
      throw new Error("Basic viewer benchmark API was not installed.");
    }

    return benchmark.verifyCameraStreamController();
  });
  await check(
    async () => cameraStreamControllerSmoke.completedPointCount > 0,
    "High-level camera stream controller did not render COPC points.",
  );
  await check(
    async () => cameraStreamControllerSmoke.listenerCountRestored,
    "High-level camera stream controller leaked Cesium camera listeners.",
  );
  await check(
    async () => cameraStreamControllerSmoke.updatePhases.includes("complete"),
    "High-level camera stream controller did not report completion.",
  );
  await page.evaluate(async () => {
    const benchmark = window.__copcBasicViewerBenchmark;

    if (!benchmark) {
      throw new Error("Basic viewer benchmark API was not installed.");
    }

    await benchmark.moveCameraForSmoothness({
      steps: 1,
      durationMilliseconds: 16,
      heightAboveCloudMeters: 2_000,
      moveMeters: 1,
    });
  });
  await waitForCameraStreamCompleteStatus();
  await waitForSceneReady();
  await waitForInteractivePointCount(10_000);
  await page.screenshot({
    path: ${JSON.stringify(autzenScreenshotPath)},
    fullPage: false,
  });

  await page.getByLabel("Renderer").selectOption("primitive");
  await waitForInteractivePointCount(minDefaultInteractivePointCount);
  primitiveRendererTiming = (await metadataValue("Renderer timing")) ?? "";
  primitiveRendererPayload = (await metadataValue("Renderer payload")) ?? "";
  await check(
    async () => (await metadataValue("Point renderer")) === "PointPrimitiveCollection",
    "Point primitive renderer was not reported after switching renderer.",
  );
  await check(
    async () => parsePointCount(primitiveRendererTiming) >= minDefaultInteractivePointCount,
    "Primitive renderer timing did not report the expected interactive point count.",
  );
  await check(
    async () => primitiveRendererPayload.includes("estimated coordinate/color payload"),
    "Primitive renderer payload estimate was not reported.",
  );

  await page.getByLabel("Renderer").selectOption("typed");
  await page.getByLabel("Sample").selectOption("sofi-stadium");
  await waitForRenderedStatus();

  await check(
    async () => (await metadataValue("Source preset")) === "SoFi Stadium",
    "SoFi preset did not load.",
  );
  await check(
    async () =>
      (await metadataValue("Coordinate transform"))?.includes("EPSG:32611"),
    "SoFi coordinate transform was not reported.",
  );
  await page.evaluate(() => {
    const checkbox = document.querySelector("#copc-auto-stream");

    if (!(checkbox instanceof HTMLInputElement)) {
      throw new Error("Stream on camera move checkbox was not found.");
    }

    if (!checkbox.checked) {
      checkbox.checked = true;
    }

    checkbox.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await waitForRenderedStatus();
  await check(
    async () => (await metadataValue("Point cache"))?.includes("hits"),
    "Point sample cache stats were not reported after camera streaming.",
  );
  await check(
    async () =>
      (await metadataValue("Point geometry cache"))?.includes("loaded batches"),
    "Point geometry cache stats were not reported after camera streaming.",
  );
  await check(
    async () => (await metadataValue("Point loader"))?.includes("Web Worker"),
    "Worker point loader status was not reported.",
  );
  await check(
    async () => (await metadataValue("Hierarchy pages"))?.includes("evictions"),
    "Hierarchy page cache stats were not reported after camera streaming.",
  );
  await check(
    async () => (await metadataValue("Camera stream diagnostics"))?.includes("depth"),
    "Camera stream diagnostics did not report selected depth.",
  );
  await check(
    async () => (await metadataValue("Camera stream prefetch")) !== undefined,
    "Camera stream prefetch metadata was not reported.",
  );
  await check(
    async () =>
      ((await page.locator("#copc-status").textContent()) ?? "").includes(
        "Camera stream previewed",
      ) ||
      ((await metadataValue("Camera stream coverage")) ?? "").includes(
        "current-view",
      ) ||
      ((await metadataValue("Camera stream coverage")) ?? "").includes(
        "detail",
      ),
    "Camera stream coverage did not report preview or current-view detail coverage.",
  );
  await check(
    async () =>
      (await metadataValue("Auto LOD"))?.includes(
        "progressive coverage",
      ),
    "Camera selection did not report progressive coverage selection.",
  );
  await page.evaluate(async () => {
    const benchmark = window.__copcBasicViewerBenchmark;

    if (!benchmark) {
      throw new Error("Basic viewer benchmark API was not installed.");
    }

    await benchmark.moveCameraForSmoothness({
      steps: 1,
      durationMilliseconds: 16,
      heightAboveCloudMeters: 1_600,
      moveMeters: 1,
    });
  });
  await waitForCameraStreamCompleteStatus();
  await waitForSceneReady();
  await waitForInteractivePointCount(10_000);
  await page.screenshot({
    path: ${JSON.stringify(screenshotPath)},
    fullPage: false,
  });
  await page.getByRole("checkbox", { name: "Stream on camera move" }).uncheck();

  await page.getByRole("textbox", { name: "COPC URL" }).fill(sofiUrl);
  await page.getByLabel("Sample").selectOption("custom");
  await page.getByRole("textbox", { name: "Source CRS" }).fill("EPSG:32611");
  await page
    .getByRole("textbox", { name: "proj4 definition" })
    .fill(sofiDefinition);
  await page.getByRole("button", { name: "Inspect" }).click();
  await waitForRenderedStatus();

  await check(
    async () =>
      (await page.locator("#copc-sample-select").inputValue()) === "custom",
    "Custom URL selection was not preserved after loading.",
  );
  await check(
    async () => !(await page.locator("#copc-source-crs").isDisabled()),
    "Projection controls should stay enabled for Custom URL.",
  );
  await check(
    async () => (await metadataValue("Source preset")) === "Custom URL",
    "Custom URL source label was not reported.",
  );
  await check(
    async () =>
      (await metadataValue("Coordinate transform"))?.includes(
        "EPSG:32611 to EPSG:4326",
      ),
    "Custom proj4 coordinate transform was not reported.",
  );
  await check(
    async () =>
      isRenderedStatus((await page.locator("#copc-status").textContent()) ?? ""),
    "Custom URL did not render the expected COPC result.",
  );
  await check(
    async () => (await page.locator("canvas").count()) > 0,
    "Cesium canvas was not rendered.",
  );

  if (localFilePath) {
    await page.getByRole("textbox", { name: "Source CRS" }).fill("");
    await page
      .getByRole("textbox", { name: "proj4 definition" })
      .fill("");
    await page.locator("#copc-file").setInputFiles(localFilePath);
    await waitForInteractivePointCount(minDefaultInteractivePointCount);

    localFileRendererTiming = (await metadataValue("Renderer timing")) ?? "";
    await check(
      async () => (await metadataValue("Source preset")) === "Local file",
      "Local COPC file source label was not reported.",
    );
    await check(
      async () =>
        (await metadataValue("Source note"))?.includes(
          "Browser-selected COPC file",
        ),
      "Local COPC file source note was not reported.",
    );
    await check(
      async () =>
        (await metadataValue("Coordinate transform"))?.includes("EPSG:2992"),
      "Local COPC file did not use the expected default Autzen transform.",
    );
    await check(
      async () => parsePointCount(localFileRendererTiming) >= minDefaultInteractivePointCount,
      "Local COPC file renderer timing did not report the expected interactive point count.",
    );
  }

  await waitForCameraStreamCompleteStatus();
  await waitForSceneReady();

  await page.screenshot({
    path: ${JSON.stringify(verificationScreenshotPath)},
    fullPage: false,
  });

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
    status: await page.locator("#copc-status").textContent(),
    coordinateTransform: await metadataValue("Coordinate transform"),
    sourcePreset: await metadataValue("Source preset"),
    primitiveRendererTiming,
    primitiveRendererPayload,
    typedRendererTiming,
    typedRendererPayload,
    typedPointGeometryTiming,
    typedPointGeometryCache,
    cameraStreamControllerSmoke,
    browserGraphics,
    localFileRendererTiming,
    autzenScreenshotPath: ${JSON.stringify(autzenScreenshotPath)},
    screenshotPath: ${JSON.stringify(screenshotPath)},
    verificationScreenshotPath: ${JSON.stringify(verificationScreenshotPath)},
  };
}
`;
}

await mkdir(outputRoot, { recursive: true });
assertInside(outputRoot, smokeRoot);
assertInside(outputRoot, localFileSampleRoot);
assertInside(outputRoot, screenshotDir);
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

if (shouldRunLocalFileSmoke) {
  await ensureLocalFileSmokeSample();
}

console.log("Building example...");
run(npmCommand, ["run", "build:example"], repoRoot);

const port = await findAvailablePort(4173);
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

  await writeFile(smokeFlowPath, createSmokeFlow(baseUrl));

  console.log("Running browser smoke flow...");
  runPlaywrightCli([
    "--config",
    playwrightConfigPath,
    "open",
    "about:blank",
  ]);
  runPlaywrightCli(["run-code", "--filename", smokeFlowPath]);

  console.log(
    `Example smoke test passed: ${autzenScreenshotPath}, ${screenshotPath}, ${verificationScreenshotPath}`,
  );
} finally {
  try {
    runPlaywrightCli(["close"]);
  } catch {
    // The browser may already be closed if startup failed.
  }
  stopServer(serverProcess);
}

async function ensureLocalFileSmokeSample() {
  await mkdir(localFileSampleRoot, { recursive: true });

  const headResponse = await fetch(localFileSampleUrl, {
    method: "HEAD",
    signal: AbortSignal.timeout(30_000),
  });

  if (!headResponse.ok) {
    throw new Error(
      `Failed to inspect local-file smoke COPC sample: ${headResponse.status} ${headResponse.statusText}`,
    );
  }

  const expectedBytes = Number(headResponse.headers.get("content-length"));

  if (Number.isSafeInteger(expectedBytes) && expectedBytes > 0) {
    try {
      const current = await stat(localFileSamplePath);

      if (current.size === expectedBytes) {
        console.log(`Using cached local-file smoke sample: ${localFileSamplePath}`);
        return;
      }
    } catch {
      // Download below when the sample is missing or incomplete.
    }
  }

  console.log(`Downloading local-file smoke sample: ${localFileSampleUrl}`);
  const response = await fetch(localFileSampleUrl, {
    signal: AbortSignal.timeout(180_000),
  });

  if (!response.ok || !response.body) {
    throw new Error(
      `Failed to download local-file smoke COPC sample: ${response.status} ${response.statusText}`,
    );
  }

  await pipeline(Readable.fromWeb(response.body), createWriteStream(localFileSamplePath));

  if (Number.isSafeInteger(expectedBytes) && expectedBytes > 0) {
    const downloaded = await stat(localFileSamplePath);

    if (downloaded.size !== expectedBytes) {
      throw new Error(
        `Downloaded local-file smoke sample size mismatch: ${downloaded.size} !== ${expectedBytes}`,
      );
    }
  }
}
