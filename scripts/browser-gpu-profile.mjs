import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const highPerformanceArg = "--force_high_performance_gpu";

const profileAliases = new Map([
  ["high-performance", "high-performance"],
  ["high", "high-performance"],
  ["dgpu", "high-performance"],
  ["discrete", "high-performance"],
  ["low-power", "low-power"],
  ["low", "low-power"],
  ["igpu", "low-power"],
  ["integrated", "low-power"],
]);

export async function resolveBrowserGpuProfile({
  baseConfigPath,
  outputRoot,
  argv = process.argv,
  env = process.env,
} = {}) {
  if (!baseConfigPath) {
    throw new Error("baseConfigPath is required.");
  }

  if (!outputRoot) {
    throw new Error("outputRoot is required.");
  }

  const profile = normalizeBrowserGpuProfile(
    readStringArgument(argv, "--browser-gpu-profile") ??
      readStringArgument(argv, "--browser-gpu") ??
      env.COPC_BROWSER_GPU_PROFILE ??
      env.COPC_BROWSER_GPU ??
      "high-performance",
  );
  const rendererPattern =
    readStringArgument(argv, "--browser-gpu-renderer-pattern") ??
    env.COPC_BROWSER_GPU_RENDERER_PATTERN ??
    undefined;
  const baseConfig = JSON.parse(await readFile(baseConfigPath, "utf8"));
  const config = applyBrowserGpuProfile(baseConfig, profile);
  const configRoot = path.join(outputRoot, "browser-gpu-config");
  const configPath = path.join(
    configRoot,
    `${path.basename(baseConfigPath, ".json")}.${profile}.json`,
  );

  await mkdir(configRoot, { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return {
    configPath,
    launchArgs: config.browser?.launchOptions?.args ?? [],
    profile,
    rendererPattern,
  };
}

export function applyBrowserGpuProfile(baseConfig, profile) {
  const config = structuredClone(baseConfig);
  config.browser ??= {};
  config.browser.launchOptions ??= {};

  const args = Array.isArray(config.browser.launchOptions.args)
    ? config.browser.launchOptions.args.filter((arg) => arg !== highPerformanceArg)
    : [];

  if (profile === "high-performance") {
    args.push(highPerformanceArg);
  }

  config.browser.launchOptions.args = args;
  return config;
}

export function createBrowserGpuRendererAssertionSource(rendererPattern) {
  return `
  const expectedBrowserGpuRendererPattern = ${JSON.stringify(rendererPattern ?? "")};

  function assertExpectedBrowserGpuRenderer(browserGraphics) {
    if (!expectedBrowserGpuRendererPattern) {
      return;
    }

    const renderer = typeof browserGraphics?.renderer === "string"
      ? browserGraphics.renderer
      : "";
    const rendererRegex = new RegExp(expectedBrowserGpuRendererPattern, "i");

    if (!rendererRegex.test(renderer)) {
      throw new Error(
        \`Browser WebGL renderer "\${renderer}" did not match \${expectedBrowserGpuRendererPattern}.\`,
      );
    }
  }
`;
}

export function normalizeBrowserGpuProfile(rawProfile) {
  const key = String(rawProfile ?? "").trim().toLowerCase();
  const profile = profileAliases.get(key);

  if (!profile) {
    throw new Error(
      `Browser GPU profile must be high-performance or low-power; received ${JSON.stringify(rawProfile)}.`,
    );
  }

  return profile;
}

function readStringArgument(argv, name) {
  const index = argv.indexOf(name);

  if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith("--")) {
    return argv[index + 1];
  }

  const inline = argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) {
    return inline.slice(name.length + 1);
  }

  return undefined;
}
