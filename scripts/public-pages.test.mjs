import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import { configureCesiumForPublicBase } from "../config/cesium-public-base.mjs";
import {
  normalizeCopcPublicBase,
  readCopcPublicBase,
} from "../config/public-base.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");

test("keeps local and existing CI example builds on the root base", () => {
  assert.equal(normalizeCopcPublicBase(undefined), "/");
  assert.equal(normalizeCopcPublicBase("  "), "/");
  assert.equal(readCopcPublicBase({}), "/");
});

test("accepts an explicit GitHub Pages repository base", () => {
  assert.equal(
    normalizeCopcPublicBase(" /COPC-Cesium-PointCloud-Provider/ "),
    "/COPC-Cesium-PointCloud-Provider/",
  );
});

test("rejects public bases that are not safe absolute pathnames", () => {
  for (const value of [
    "COPC-Cesium-PointCloud-Provider/",
    "/COPC-Cesium-PointCloud-Provider",
    "https://example.test/COPC-Cesium-PointCloud-Provider/",
    "//example.test/",
    "/../COPC-Cesium-PointCloud-Provider/",
    "/COPC-Cesium-PointCloud-Provider/?preview=1",
    "/COPC Cesium PointCloud Provider/",
  ]) {
    assert.throws(() => normalizeCopcPublicBase(value));
  }
});

test("keeps Cesium files at the artifact root while publishing subpath URLs", () => {
  const observedConfigs = [];
  const context = { marker: "plugin-context" };
  const cesiumPlugin = {
    name: "fake-vite-plugin-cesium",
    config(config, environment) {
      observedConfigs.push({ config, context: this, environment });
      return { define: { FROM_FAKE_CESIUM_PLUGIN: "true" } };
    },
  };
  const [wrappedCesiumPlugin, publicCesiumUrlPlugin] =
    configureCesiumForPublicBase(
      cesiumPlugin,
      "/COPC-Cesium-PointCloud-Provider/",
    );
  const userConfig = {
    base: "/COPC-Cesium-PointCloud-Provider/",
    build: { outDir: "dist/example" },
  };

  assert.deepEqual(
    wrappedCesiumPlugin.config.call(context, userConfig, {
      command: "build",
      mode: "production",
    }),
    { define: { FROM_FAKE_CESIUM_PLUGIN: "true" } },
  );
  assert.equal(observedConfigs[0].config.base, "/");
  assert.equal(observedConfigs[0].config.build, userConfig.build);
  assert.equal(observedConfigs[0].context, context);
  assert.equal(userConfig.base, "/COPC-Cesium-PointCloud-Provider/");

  assert.equal(
    publicCesiumUrlPlugin.transformIndexHtml.handler(
      '<link href="/cesium/Widgets/widgets.css"><script src="/cesium/Cesium.js"></script>',
    ),
    '<link href="/COPC-Cesium-PointCloud-Provider/cesium/Widgets/widgets.css"><script src="/COPC-Cesium-PointCloud-Provider/cesium/Cesium.js"></script>',
  );
});

test("pins the official Pages workflow and verifies the subpath build before upload", async () => {
  const workflow = await readFile(
    path.join(repoRoot, ".github", "workflows", "pages.yml"),
    "utf8",
  );

  assert.match(workflow, /push:\s+branches:\s+- main/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(
    workflow,
    /actions\/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5 # v4/,
  );
  assert.match(
    workflow,
    /actions\/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4/,
  );
  assert.match(
    workflow,
    /actions\/configure-pages@983d7736d9b0ae728b81ab479565c72886d7745b # v5\.0\.0/,
  );
  assert.match(
    workflow,
    /actions\/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5\.0\.0/,
  );
  assert.match(
    workflow,
    /actions\/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5\.0\.0/,
  );
  assert.match(
    workflow,
    /COPC_PUBLIC_BASE: \$\{\{ steps\.pages\.outputs\.base_path \}\}\//,
  );
  assert.match(workflow, /run: npm run build:example/);
  assert.match(workflow, /run: npm run verify:pages/);
  assert.match(workflow, /path: dist\/example/);
  assert.match(workflow, /name: github-pages\s+url: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  assert.match(workflow, /pages: write/);
  assert.match(workflow, /id-token: write/);

  for (const actionReference of workflow.matchAll(/uses:\s+([^\s]+)/g)) {
    assert.match(
      actionReference[1],
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/,
    );
  }
});

test("publishes the canonical project identity and demo URL", async () => {
  const [packageJsonText, readme, competition, exampleHtml] = await Promise.all([
    readFile(path.join(repoRoot, "package.json"), "utf8"),
    readFile(path.join(repoRoot, "README.md"), "utf8"),
    readFile(path.join(repoRoot, "docs", "COMPETITION.md"), "utf8"),
    readFile(
      path.join(repoRoot, "examples", "basic-viewer", "index.html"),
      "utf8",
    ),
  ]);
  const packageJson = JSON.parse(packageJsonText);
  const projectName = "COPC Cesium PointCloud Provider";
  const repositoryUrl =
    "https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider";
  const demoUrl =
    "https://kimddong03.github.io/COPC-Cesium-PointCloud-Provider/";

  assert.equal(packageJson.homepage, demoUrl);
  assert.equal(packageJson.repository.url, `git+${repositoryUrl}.git`);
  assert.equal(packageJson.bugs.url, `${repositoryUrl}/issues`);
  assert.match(packageJson.description, new RegExp(`^${projectName}:`));
  assert.match(readme, new RegExp(`^# ${projectName}$`, "m"));
  assert.ok(readme.includes("import identifier remain `copc-cesium`"));
  assert.ok(readme.includes(demoUrl));
  assert.ok(competition.includes(projectName));
  assert.ok(competition.includes(demoUrl));
  assert.ok(exampleHtml.includes(`<title>${projectName} |`));
  assert.ok(exampleHtml.includes(`<h1>${projectName}</h1>`));
  const retiredRepositoryMarker = ["COPC", "VIEWER"].join("_");

  for (const publicDocument of [
    packageJsonText,
    readme,
    competition,
    exampleHtml,
  ]) {
    assert.ok(!publicDocument.includes(retiredRepositoryMarker));
  }
});
