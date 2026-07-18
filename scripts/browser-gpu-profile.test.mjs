import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "vitest";
import {
  applyBrowserGpuProfile,
  createBrowserGpuRendererAssertionSource,
  normalizeBrowserGpuProfile,
  resolveBrowserGpuProfile,
} from "./browser-gpu-profile.mjs";

describe("browser GPU profile resolver", () => {
  it("keeps high-performance as the default launch behavior", () => {
    const config = applyBrowserGpuProfile({ browser: { launchOptions: {} } }, "high-performance");

    assert.deepEqual(config.browser.launchOptions.args, [
      "--force_high_performance_gpu",
    ]);
  });

  it("uses an omitted high-performance flag for the low-power profile", () => {
    const config = applyBrowserGpuProfile(
      {
        browser: {
          isolated: true,
          launchOptions: {
            args: ["--force_high_performance_gpu", "--some-other-flag"],
          },
          contextOptions: {
            deviceScaleFactor: 1,
          },
        },
      },
      "low-power",
    );

    assert.equal(config.browser.isolated, true);
    assert.deepEqual(config.browser.contextOptions, { deviceScaleFactor: 1 });
    assert.deepEqual(config.browser.launchOptions.args, ["--some-other-flag"]);
  });

  it("accepts CLI and environment aliases", () => {
    assert.equal(normalizeBrowserGpuProfile("dgpu"), "high-performance");
    assert.equal(normalizeBrowserGpuProfile("igpu"), "low-power");
    assert.equal(normalizeBrowserGpuProfile("integrated"), "low-power");
    assert.throws(
      () => normalizeBrowserGpuProfile("unknown"),
      /Browser GPU profile must be high-performance or low-power/,
    );
  });

  it("writes a resolved config and returns the renderer assertion pattern", async () => {
    const tempRoot = await makeTempRoot();
    const baseConfigPath = path.join(tempRoot, "playwright.base.json");
    const outputRoot = path.join(tempRoot, "output");

    await writeFile(
      baseConfigPath,
      JSON.stringify({
        browser: {
          launchOptions: {
            args: ["--force_high_performance_gpu"],
          },
        },
      }),
    );

    try {
      const resolved = await resolveBrowserGpuProfile({
        baseConfigPath,
        outputRoot,
        argv: [
          "node",
          "script.mjs",
          "--browser-gpu=igpu",
          "--browser-gpu-renderer-pattern",
          "AMD",
        ],
        env: {},
      });
      const writtenConfig = JSON.parse(await readFile(resolved.configPath, "utf8"));

      assert.equal(resolved.profile, "low-power");
      assert.equal(resolved.rendererPattern, "AMD");
      assert.match(resolved.configPath, /playwright\.base\.low-power\.json$/);
      assert.deepEqual(writtenConfig.browser.launchOptions.args, []);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("emits a browser renderer assertion helper for generated flows", () => {
    const source = createBrowserGpuRendererAssertionSource("RTX|AMD");

    assert.match(source, /expectedBrowserGpuRendererPattern/);
    assert.match(source, /Browser WebGL renderer/);
    assert.match(source, /new RegExp\(expectedBrowserGpuRendererPattern, "i"\)/);
  });
});

async function makeTempRoot() {
  const tempRoot = path.join(
    os.tmpdir(),
    `copc-browser-gpu-profile-${process.pid}-${Date.now()}`,
  );

  await mkdir(tempRoot, { recursive: true });
  return tempRoot;
}
