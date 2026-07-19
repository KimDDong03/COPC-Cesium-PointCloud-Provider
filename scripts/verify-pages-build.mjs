import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readCopcPublicBase } from "../config/public-base.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const defaultBuildRoot = path.join(repoRoot, "dist", "example");
const requiredWorkerPrefixes = [
  "CopcPointSampleWorker-",
  "CesiumPointGeometryWorker-",
  "CesiumCopcPointGeometryWorker-",
];

export async function verifyPagesBuild({
  buildRoot = defaultBuildRoot,
  publicBase = readCopcPublicBase(),
} = {}) {
  const resolvedBuildRoot = path.resolve(buildRoot);
  const indexPath = path.join(resolvedBuildRoot, "index.html");
  const indexHtml = await readFile(indexPath, "utf8");
  const htmlAssetUrls = readHtmlAssetUrls(indexHtml);

  if (htmlAssetUrls.length === 0) {
    throw new Error("Pages build index.html does not reference any local assets.");
  }

  for (const assetUrl of htmlAssetUrls) {
    if (!assetUrl.startsWith(publicBase)) {
      throw new Error(
        `Pages build asset URL ${assetUrl} does not start with ${publicBase}.`,
      );
    }

    await access(resolvePublicAssetPath(resolvedBuildRoot, publicBase, assetUrl));
  }

  await access(path.join(resolvedBuildRoot, "cesium", "Cesium.js"));
  await access(
    path.join(resolvedBuildRoot, "cesium", "Widgets", "widgets.css"),
  );

  const cesiumWorkers = await readdir(
    path.join(resolvedBuildRoot, "cesium", "Workers"),
  );

  if (!cesiumWorkers.some((fileName) => fileName.endsWith(".js"))) {
    throw new Error("Pages build does not contain Cesium worker assets.");
  }

  const assetRoot = path.join(resolvedBuildRoot, "assets");
  const assetNames = await readdir(assetRoot);
  const workerAssetNames = requiredWorkerPrefixes.map((prefix) =>
    requireSingleAsset(assetNames, prefix, ".js"),
  );
  const wasmAssetNames = assetNames.filter((fileName) => fileName.endsWith(".wasm"));

  if (wasmAssetNames.length !== 1) {
    throw new Error(
      `Pages build must contain exactly one LAZ WASM asset; found ${wasmAssetNames.length}.`,
    );
  }

  const javascriptAssetNames = assetNames.filter((fileName) =>
    fileName.endsWith(".js"),
  );
  const javascript = (
    await Promise.all(
      javascriptAssetNames.map((fileName) =>
        readFile(path.join(assetRoot, fileName), "utf8"),
      ),
    )
  ).join("\n");

  for (const assetName of [...workerAssetNames, ...wasmAssetNames]) {
    const expectedUrl = `${publicBase}assets/${assetName}`;

    if (!javascript.includes(expectedUrl)) {
      throw new Error(
        `Pages build JavaScript does not reference ${expectedUrl}.`,
      );
    }
  }

  return {
    buildRoot: resolvedBuildRoot,
    publicBase,
    htmlAssetCount: htmlAssetUrls.length,
    cesiumWorkerCount: cesiumWorkers.filter((fileName) => fileName.endsWith(".js"))
      .length,
    workerAssets: workerAssetNames,
    wasmAsset: wasmAssetNames[0],
  };
}

function readHtmlAssetUrls(indexHtml) {
  return [...indexHtml.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)]
    .map((match) => match[1])
    .filter(
      (url) =>
        !url.startsWith("data:") &&
        !url.startsWith("https://") &&
        !url.startsWith("http://") &&
        !url.startsWith("#"),
    );
}

function resolvePublicAssetPath(buildRoot, publicBase, assetUrl) {
  const pathname = assetUrl.split(/[?#]/, 1)[0];
  const relativePath = decodeURIComponent(pathname.slice(publicBase.length));
  const resolvedPath = path.resolve(buildRoot, relativePath);
  const relativeToBuildRoot = path.relative(buildRoot, resolvedPath);

  if (
    relativeToBuildRoot === "" ||
    relativeToBuildRoot.startsWith("..") ||
    path.isAbsolute(relativeToBuildRoot)
  ) {
    throw new Error(`Pages build asset URL escapes the build root: ${assetUrl}.`);
  }

  return resolvedPath;
}

function requireSingleAsset(assetNames, prefix, extension) {
  const matches = assetNames.filter(
    (fileName) => fileName.startsWith(prefix) && fileName.endsWith(extension),
  );

  if (matches.length !== 1) {
    throw new Error(
      `Pages build must contain exactly one ${prefix}*${extension} asset; found ${matches.length}.`,
    );
  }

  return matches[0];
}

const invokedPath = process.argv[1]
  ? pathToFileURL(path.resolve(process.argv[1])).href
  : undefined;

if (invokedPath === import.meta.url) {
  const result = await verifyPagesBuild();
  console.log(JSON.stringify(result, null, 2));
}
