import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";
import { resolveLocalPackageBinary } from "./resolve-local-package-binary.mjs";

const packageJsonPath = fileURLToPath(
  new URL("../package.json", import.meta.url),
);
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
const packageLockJson = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package-lock.json", import.meta.url)), "utf8"),
);

describe("published package contract", () => {
  test("keeps the Node requirement scoped to repository development", () => {
    assert.equal(packageJson.engines, undefined);
    assert.deepEqual(packageJson.devEngines, {
      runtime: {
        name: "node",
        version: ">=22 <23",
        onFail: "error",
      },
      packageManager: {
        name: "npm",
        version: ">=11.16.0 <12",
        onFail: "warn",
      },
    });
  });

  test("installs strict declaration prerequisites for consumers", () => {
    assert.equal(packageJson.dependencies["@types/emscripten"], "^1.41.5");
    assert.equal(packageJson.devDependencies["@types/emscripten"], undefined);
    assert.equal(packageJson.peerDependencies.cesium, ">=1.140.0 <2");
  });

  test("publishes typed ESM entry points without a CommonJS claim", () => {
    assert.equal(packageJson.type, "module");

    for (const entryPoint of [".", "./core", "./cesium"]) {
      assert.match(packageJson.exports[entryPoint].types, /\.d\.ts$/);
      assert.match(packageJson.exports[entryPoint].import, /\.js$/);
      assert.equal(packageJson.exports[entryPoint].require, undefined);
    }
  });

  test("packages consumer evidence without repository-only submission scripts", () => {
    const publishedDocs = packageJson.files.filter((entry) =>
      entry.startsWith("docs/"),
    );

    assert.deepEqual(publishedDocs, [
      "docs/API.md",
      "docs/ARCHITECTURE.md",
      "docs/COMPETITION.md",
      "docs/DATASETS.md",
      "docs/PERFORMANCE.md",
      "docs/RELEASE.md",
      "docs/sbom.spdx.json",
    ]);
    assert.equal(publishedDocs.includes("docs/DEMO_SCRIPT_KO.md"), false);
    assert.equal(
      publishedDocs.includes("docs/SUBMISSION_CHECKLIST_KO.md"),
      false,
    );
  });

  test("locks the browser QC CLI and runs only the local binary", () => {
    assert.equal(packageJson.devDependencies["@playwright/cli"], "0.1.17");
    assert.equal(
      packageLockJson.packages[""].devDependencies["@playwright/cli"],
      "0.1.17",
    );
    assert.equal(
      packageLockJson.packages["node_modules/@playwright/cli"].version,
      "0.1.17",
    );
    assert.equal(
      packageJson.scripts["smoke:example:install-browser"],
      "playwright-cli install-browser chrome-for-testing",
    );
    assert.equal(
      existsSync(
        resolveLocalPackageBinary(
          fileURLToPath(new URL("../", import.meta.url)),
          "@playwright/cli",
          "playwright-cli",
        ),
      ),
      true,
    );

    for (const relativePath of [
      "benchmark-renderers.mjs",
      "benchmark-smoothness.mjs",
      "smoke-example.mjs",
      "smoke-package.mjs",
    ]) {
      const source = readFileSync(
        fileURLToPath(new URL(relativePath, import.meta.url)),
        "utf8",
      );

      assert.doesNotMatch(source, /\bnpx\b|--package/);
      assert.match(source, /resolveLocalPackageBinary/);
      assert.match(source, /\[playwrightCliPath, \.\.\.args\]/);
    }
  });

  test("binds installed-package browser evidence to the source state and exact tarball", () => {
    const source = readFileSync(
      fileURLToPath(new URL("smoke-package.mjs", import.meta.url)),
      "utf8",
    );

    assert.match(
      source,
      /import \{\s*createRunEvidence,\s*validateRunEvidence,\s*validateRunEvidenceSourceState,\s*\} from "\.\/run-evidence\.mjs";/,
    );
    assert.match(
      source,
      /const runEvidence = await createRunEvidence\(\{ repoRoot \}\);/,
    );
    assert.match(
      source,
      /validateRunEvidence\(\s*runEvidence,\s*"packageSmoke\.runEvidence",?\s*\)/,
    );
    assert.match(
      source,
      /validateRunEvidenceSourceState\(\s*runEvidence,\s*packagedSourceEvidence,\s*"packageSmoke\.sourceState",?\s*\)/,
    );

    const emittedRunEvidenceFields =
      source.match(
        /^\s+runEvidence,\r?\n\s+releaseCandidateArtifact,$/gm,
      ) ?? [];
    assert.equal(
      emittedRunEvidenceFields.length,
      2,
      "success and fallback browser-result records must retain runEvidence",
    );
    const emittedArtifactFields =
      source.match(/^\s+releaseCandidateArtifact,$/gm) ?? [];
    assert.equal(
      emittedArtifactFields.length,
      2,
      "success and fallback browser-result records must retain the RC artifact identity",
    );
    assert.match(
      source,
      /const releaseCandidateArtifact = \{\s*kind: "npm-tarball",\s*packageName: packResult\.name,\s*packageVersion: packResult\.version,\s*fileName: tarballName,\s*byteCount: tarballBytes\.byteLength,\s*digest: \{\s*algorithm: "sha256",\s*value: tarballSha256,/,
    );
    assert.match(source, /tarballSha256,/);
  });

  test("drives a bounded real wheel sequence to deterministic terminal LOD evidence", () => {
    const source = readFileSync(
      fileURLToPath(new URL("smoke-package.mjs", import.meta.url)),
      "utf8",
    );

    assert.doesNotMatch(source, /page\.mouse\.wheel\(0, -300\)/);
    assert.match(
      source,
      /zoomTargetCameraHeightMeters = Math\.min\(\s*650,\s*overviewCameraHeightMeters \* 0\.25,\s*\);/,
    );
    assert.match(source, /const minimumZoomInputCount = 3;/);
    assert.match(source, /const maximumZoomInputCount = 32;/);
    assert.match(source, /await page\.mouse\.wheel\(0, -60\);/);
    assert.match(
      source,
      /__COPC_PACKAGE_SMOKE_READ_CAMERA_HEIGHT_METERS__\?: \(\) => number \| undefined;/,
    );
    assert.match(
      source,
      /layer\.getCameraHeightAbovePointCloudMeters\(\s*viewer\.camera\.positionCartographic\.height,\s*\)/,
    );
    assert.match(
      source,
      /isMeaningfulZoomRefinement \? "passed" : "ready"/,
      "an intermediate terminal must remain non-fatal while the input sequence approaches its target",
    );
    assert.match(
      source,
      /streamEvidence\.selectedDepth > overviewStream\.selectedDepth/,
    );
    assert.match(
      source,
      /streamEvidence\.renderedPointCount >=\s*overviewStream\.renderedPointCount \* 1\.25/,
    );
    assert.match(
      source,
      /streamEvidence\.normalizedDensity > overviewStream\.normalizedDensity/,
    );
  });
});
