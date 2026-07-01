import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(repoRoot, "output");
const benchmarkRoot = path.join(outputRoot, "renderer-benchmark");
const benchmarkFlowPath = path.join(benchmarkRoot, "renderer-benchmark-flow.mjs");
const benchmarkResultPath = path.join(benchmarkRoot, "renderers.json");
const isWindows = process.platform === "win32";
const npmCommand = "npm";
const npxCommand = "npx";
const playwrightCliPackage = "@playwright/cli@0.1.14";
const benchmarkPointCount = readPositiveIntegerEnv(
  "COPC_BENCHMARK_POINT_COUNT",
  10_000,
);
const benchmarkRepeats = readPositiveIntegerEnv("COPC_BENCHMARK_REPEATS", 3);

if (benchmarkPointCount <= 5_000) {
  throw new Error(
    "COPC_BENCHMARK_POINT_COUNT must be greater than 5000 for the renderer benchmark.",
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

function createBenchmarkFlow(baseUrl, targetPointCount, repeatCount) {
  return `async (page) => {
  const renderers = ["primitive", "buffer"];
  const targetPointCount = ${JSON.stringify(targetPointCount)};
  const repeatCount = ${JSON.stringify(repeatCount)};
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

  async function setBenchmarkControls(renderer) {
    await page.evaluate(
      ({ renderer, targetPointCount }) => {
        const rendererSelect = document.querySelector("#copc-renderer-select");
        const maxPointCountInput = document.querySelector("#copc-max-point-count");

        if (!(rendererSelect instanceof HTMLSelectElement)) {
          throw new Error("Renderer select was not found.");
        }

        if (!(maxPointCountInput instanceof HTMLInputElement)) {
          throw new Error("Max point count input was not found.");
        }

        rendererSelect.value = renderer;
        maxPointCountInput.value = String(targetPointCount);
      },
      { renderer, targetPointCount },
    );
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

  async function triggerRender() {
    await page.evaluate(() => {
      const form = document.querySelector("#copc-form");
      const status = document.querySelector("#copc-status");

      if (!(form instanceof HTMLFormElement)) {
        throw new Error("COPC form was not found.");
      }

      if (status) {
        status.textContent = "Benchmark render pending...";
      }

      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await waitForRenderedStatus();
  }

  function parseRendererTiming(timing) {
    const match = timing.match(
      /^([\\d,]+) pts, transform ([\\d.]+) ms, renderer ([\\d.]+) ms, bounds ([\\d.]+) ms, total ([\\d.]+) ms$/,
    );

    if (!match) {
      throw new Error(\`Could not parse renderer timing: \${timing}\`);
    }

    return {
      pointCount: Number(match[1].replaceAll(",", "")),
      coordinateTransformMilliseconds: Number(match[2]),
      rendererSetPointsMilliseconds: Number(match[3]),
      boundsRenderMilliseconds: Number(match[4]),
      totalRenderMilliseconds: Number(match[5]),
    };
  }

  function average(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function summarizeRenderer(renderer) {
    const rendererResults = results.filter((result) => result.renderer === renderer);

    return {
      renderer,
      rendererLabel: rendererResults[0]?.rendererLabel ?? "",
      runCount: rendererResults.length,
      targetPointCount,
      minPointCount: Math.min(...rendererResults.map((result) => result.pointCount)),
      maxPointCount: Math.max(...rendererResults.map((result) => result.pointCount)),
      averageCoordinateTransformMilliseconds: average(
        rendererResults.map((result) => result.coordinateTransformMilliseconds),
      ),
      averageRendererSetPointsMilliseconds: average(
        rendererResults.map((result) => result.rendererSetPointsMilliseconds),
      ),
      averageBoundsRenderMilliseconds: average(
        rendererResults.map((result) => result.boundsRenderMilliseconds),
      ),
      averageTotalRenderMilliseconds: average(
        rendererResults.map((result) => result.totalRenderMilliseconds),
      ),
      rendererPayload: rendererResults[0]?.rendererPayload ?? "",
    };
  }

  await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: "domcontentloaded" });
  await waitForRenderedStatus();

  for (const renderer of renderers) {
    await setBenchmarkControls(renderer);

    for (let runIndex = 0; runIndex < repeatCount; runIndex += 1) {
      await triggerRender();

      const timing = (await metadataValue("Renderer timing")) ?? "";
      const payload = (await metadataValue("Renderer payload")) ?? "";
      const rendererLabel = (await metadataValue("Point renderer")) ?? "";
      const maxPointsPerNode = (await metadataValue("Max points / node")) ?? "";
      const parsedTiming = parseRendererTiming(timing);

      if (parsedTiming.pointCount <= 5000) {
        failures.push(
          \`\${renderer} run \${runIndex + 1} rendered \${parsedTiming.pointCount} points; expected more than 5000.\`,
        );
      }

      results.push({
        renderer,
        rendererLabel,
        runIndex: runIndex + 1,
        targetPointCount,
        maxPointsPerNode,
        rendererTiming: timing,
        rendererPayload: payload,
        ...parsedTiming,
      });
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
    targetPointCount,
    repeatCount,
    sourcePreset: await metadataValue("Source preset"),
    coordinateTransform: await metadataValue("Coordinate transform"),
    summaries: renderers.map(summarizeRenderer),
    results,
  };
}
`;
}

function printBenchmarkSummary(result) {
  console.log("Renderer benchmark summary:");

  for (const summary of result.summaries) {
    console.log(
      [
        `- ${summary.renderer}: ${summary.runCount} runs`,
        `${summary.minPointCount.toLocaleString()}-${summary.maxPointCount.toLocaleString()} pts`,
        `renderer avg ${summary.averageRendererSetPointsMilliseconds.toFixed(2)} ms`,
        `total avg ${summary.averageTotalRenderMilliseconds.toFixed(2)} ms`,
        summary.rendererPayload,
      ].join(", "),
    );
  }
}

await mkdir(outputRoot, { recursive: true });
assertInside(outputRoot, benchmarkRoot);
await rm(benchmarkRoot, { recursive: true, force: true });
await mkdir(benchmarkRoot, { recursive: true });

console.log("Building example...");
run(npmCommand, ["run", "build:example"], repoRoot);

const port = await findAvailablePort(4273);
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
    createBenchmarkFlow(baseUrl, benchmarkPointCount, benchmarkRepeats),
  );

  console.log(
    `Running renderer benchmark: ${benchmarkPointCount.toLocaleString()} max points / node, ${benchmarkRepeats.toLocaleString()} repeats...`,
  );
  runPlaywrightCli(["open", "about:blank"]);
  const output = runPlaywrightCli(["run-code", "--filename", benchmarkFlowPath]);
  const result = extractPlaywrightResult(output);
  await writeFile(benchmarkResultPath, `${JSON.stringify(result, null, 2)}\n`);
  printBenchmarkSummary(result);
  console.log(`Renderer benchmark result written: ${benchmarkResultPath}`);
} finally {
  try {
    runPlaywrightCli(["close"]);
  } catch {
    // The browser may already be closed if startup failed.
  }
  stopServer(serverProcess);
}
