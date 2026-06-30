import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const outputRoot = path.join(repoRoot, "output");
const smokeRoot = path.join(outputRoot, "package-smoke");
const consumerRoot = path.join(smokeRoot, "consumer");
const isWindows = process.platform === "win32";
const npmCommand = "npm";
const npxCommand = "npx";

function assertInside(parent, target) {
  const relative = path.relative(parent, target);

  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to operate outside ${parent}: ${target}`);
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
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

function runCapture(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    shell: isWindows,
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}`);
  }

  return result.stdout;
}

function toFileDependency(filePath) {
  return `file:${filePath.replaceAll("\\", "/")}`;
}

await mkdir(outputRoot, { recursive: true });
assertInside(outputRoot, smokeRoot);
await rm(smokeRoot, { recursive: true, force: true });
await mkdir(path.join(consumerRoot, "src"), { recursive: true });

console.log("Building library and example...");
run(npmCommand, ["run", "build"], repoRoot);

console.log("Packing local package...");
const packOutput = runCapture(
  npmCommand,
  ["pack", "--pack-destination", smokeRoot],
  repoRoot,
);
const tarballName = packOutput.trim().split(/\r?\n/).at(-1);

if (!tarballName) {
  throw new Error("npm pack did not return a tarball name.");
}

const tarballPath = path.join(smokeRoot, tarballName);

if (!existsSync(tarballPath)) {
  throw new Error(`Packed tarball was not created: ${tarballPath}`);
}

await writeFile(
  path.join(consumerRoot, "package.json"),
  `${JSON.stringify(
    {
      private: true,
      type: "module",
      scripts: {
        build: "vite build",
        typecheck: "tsc --noEmit",
      },
      dependencies: {
        "copc-cesium": toFileDependency(tarballPath),
      },
      devDependencies: {
        typescript: "^5.9.3",
        vite: "^7.2.7",
      },
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  path.join(consumerRoot, "tsconfig.json"),
  `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        useDefineForClassFields: true,
        module: "ESNext",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        skipLibCheck: true,
        moduleResolution: "Bundler",
        allowSyntheticDefaultImports: true,
        isolatedModules: true,
        moduleDetection: "force",
        noEmit: true,
        strict: true,
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`,
);

await writeFile(
  path.join(consumerRoot, "index.html"),
  `<div id="app"></div><script type="module" src="/src/main.ts"></script>\n`,
);

await writeFile(
  path.join(consumerRoot, "src", "main.ts"),
  `import {
  CopcPointCloudLayer,
  createDefaultCopcCoordinateTransforms,
  createProj4CoordinateTransforms,
  selectHierarchyPagesForTarget,
  type CopcHierarchyNodeDepthEstimate,
  type CopcPointCloudLayerCameraSelectionOptions,
  type CopcCoordinateTransformStatus,
  type CopcHierarchyPageReference,
  type CopcHierarchyPageTargetSelection,
  type CopcInspection,
  type CopcPointCloudLayerHierarchyExpansionOptions,
} from "copc-cesium";
import {
  CopcSource,
  createCopcPointSampleWorker,
  type CopcHierarchyCacheStats,
  type LoadNodePointSamplesOptions,
  type CopcPointSampleLoadingMode,
  type CopcPointSampleCacheStats,
  type CopcTargetVector,
  type CopcSourceOptions,
} from "copc-cesium/core";
import { CesiumPointRenderer } from "copc-cesium/cesium";

const exportedConstructors = [
  CopcPointCloudLayer,
  CopcSource,
  CesiumPointRenderer,
  createDefaultCopcCoordinateTransforms,
  createProj4CoordinateTransforms,
  createCopcPointSampleWorker,
  selectHierarchyPagesForTarget,
] as const;
const pointSampleLoadingMode: CopcPointSampleLoadingMode = "worker";
const inspection: CopcInspection | undefined = undefined;
const transformStatus: CopcCoordinateTransformStatus | undefined = undefined;
const hierarchyCacheStats: CopcHierarchyCacheStats = {
  loadedPageCount: 1,
  maxCachedPageCount: 3,
  pendingPageCount: 0,
  trackedNodeCount: 1,
  trackedPendingPageCount: 0,
  cacheEvictionCount: 0,
  isOverLimit: false,
};
const cacheStats: CopcPointSampleCacheStats | undefined = undefined;
const sourceOptions: CopcSourceOptions = {
  maxCachedHierarchyPages: 3,
  maxCachedSampleSets: 2,
  maxCachedPointSampleBytes: 1024,
  maxConcurrentPointSampleWorkerRequests: 2,
  pointSampleLoading: pointSampleLoadingMode,
};
const nodeSampleOptions: LoadNodePointSamplesOptions = {
  nodeKey: "0-0-0-0",
  signal: new AbortController().signal,
};
const viewDirection: CopcTargetVector = { x: 1, y: 0, z: 0 };
const createSource = (): CopcSource =>
  new CopcSource("https://example.com/sample.copc.laz", sourceOptions);
const depthEstimate: CopcHierarchyNodeDepthEstimate | undefined = undefined;
const hierarchyPage: CopcHierarchyPageReference | undefined = undefined;
const pageSelection: CopcHierarchyPageTargetSelection | undefined = undefined;
const hierarchyExpansionOptions:
  | CopcPointCloudLayerHierarchyExpansionOptions
  | undefined = undefined;
const cameraSelectionOptions:
  | CopcPointCloudLayerCameraSelectionOptions
  | undefined = {
    camera: {} as CopcPointCloudLayerCameraSelectionOptions["camera"],
    maxViewAngleDegrees: 80,
  };
const app = document.querySelector<HTMLDivElement>("#app");

if (app) {
  app.textContent = [
    exportedConstructors.map((constructor) => constructor.name).join(", "),
    String(Boolean(createSource)),
    pointSampleLoadingMode,
    String(sourceOptions.maxCachedHierarchyPages),
    String(sourceOptions.maxCachedSampleSets),
    String(sourceOptions.maxCachedPointSampleBytes),
    String(sourceOptions.maxConcurrentPointSampleWorkerRequests),
    String(Boolean(nodeSampleOptions.signal)),
    String(Boolean(viewDirection)),
    String(Boolean(depthEstimate)),
    String(Boolean(inspection)),
    String(Boolean(transformStatus)),
    String(hierarchyCacheStats.cacheEvictionCount),
    String(Boolean(cacheStats)),
    String(Boolean(hierarchyPage)),
    String(Boolean(pageSelection)),
    String(Boolean(hierarchyExpansionOptions)),
    String(Boolean(cameraSelectionOptions)),
  ].join(" | ");
}
`,
);

console.log("Installing packed package into temporary consumer...");
run(npmCommand, ["install"], consumerRoot);

console.log("Type-checking temporary consumer...");
run(npxCommand, ["tsc", "--noEmit"], consumerRoot);

console.log("Building temporary consumer...");
run(npxCommand, ["vite", "build"], consumerRoot);

console.log(`Package smoke test passed: ${tarballPath}`);
