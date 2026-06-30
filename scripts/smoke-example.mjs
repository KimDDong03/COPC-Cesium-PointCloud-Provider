import { spawn, spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(repoRoot, "output");
const smokeRoot = path.join(outputRoot, "example-smoke");
const screenshotDir = path.join(outputRoot, "playwright");
const smokeFlowPath = path.join(smokeRoot, "smoke-example-flow.mjs");
const screenshotPath = path.join(screenshotDir, "smoke-example.png");
const isWindows = process.platform === "win32";
const npmCommand = "npm";
const npxCommand = "npx";
const playwrightCliPackage = "@playwright/cli@0.1.14";

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

  const expectedStatus = "Rendered 5,000 real COPC points";
  const sofiUrl = "https://s3.amazonaws.com/hobu-lidar/sofi.copc.laz";
  const sofiDefinition =
    "+proj=utm +zone=11 +datum=WGS84 +units=m +no_defs +type=crs";

  async function metadataValue(label) {
    return page.evaluate((targetLabel) => {
      const rows = [...document.querySelectorAll("#copc-metadata dt")];
      return rows.find((row) => row.textContent === targetLabel)
        ?.nextElementSibling?.textContent;
    }, label);
  }

  async function waitForRenderedStatus() {
    await waitForStatusIncludes(expectedStatus);
  }

  async function waitForStatusIncludes(statusText) {
    try {
      await page.waitForFunction(
        (statusText) =>
          document.querySelector("#copc-status")?.textContent?.includes(statusText),
        statusText,
        { timeout: 60_000 },
      );
    } catch (error) {
      const currentStatus = await page.locator("#copc-status").textContent();
      throw new Error(
        \`Timed out waiting for status "\${statusText}". Current status: "\${currentStatus}". \${error.message}\`,
      );
    }
  }

  async function check(condition, message) {
    if (!(await condition())) {
      failures.push(message);
    }
  }

  await page.goto(${JSON.stringify(baseUrl)}, { waitUntil: "domcontentloaded" });
  await waitForRenderedStatus();

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
    async () => page.locator("#copc-source-crs").isDisabled(),
    "Projection controls should be disabled for sample presets.",
  );

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
  await page.getByRole("checkbox", { name: "Stream on camera move" }).check();
  await waitForStatusIncludes("Camera stream rendered");
  await check(
    async () => (await metadataValue("Point cache"))?.includes("hits"),
    "Point sample cache stats were not reported after camera streaming.",
  );
  await check(
    async () => (await metadataValue("Point loader"))?.includes("Web Worker"),
    "Worker point loader status was not reported.",
  );
  await check(
    async () => (await metadataValue("Hierarchy pages"))?.includes("evictions"),
    "Hierarchy page cache stats were not reported after camera streaming.",
  );
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
      (await page.locator("#copc-status").textContent())?.includes(expectedStatus),
    "Custom URL did not render the expected COPC point sample count.",
  );
  await check(
    async () => (await page.locator("canvas").count()) > 0,
    "Cesium canvas was not rendered.",
  );

  await page.screenshot({
    path: ${JSON.stringify(screenshotPath)},
    fullPage: true,
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
    screenshotPath: ${JSON.stringify(screenshotPath)},
  };
}
`;
}

await mkdir(outputRoot, { recursive: true });
assertInside(outputRoot, smokeRoot);
assertInside(outputRoot, screenshotDir);
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(smokeRoot, { recursive: true });
await mkdir(screenshotDir, { recursive: true });

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
  runPlaywrightCli(["open", "about:blank"]);
  runPlaywrightCli(["run-code", "--filename", smokeFlowPath]);

  console.log(`Example smoke test passed: ${screenshotPath}`);
} finally {
  try {
    runPlaywrightCli(["close"]);
  } catch {
    // The browser may already be closed if startup failed.
  }
  stopServer(serverProcess);
}
