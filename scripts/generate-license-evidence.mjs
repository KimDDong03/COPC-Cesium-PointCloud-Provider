import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const lockPath = path.join(repoRoot, "package-lock.json");
const packagePath = path.join(repoRoot, "package.json");
const noticesPath = path.join(repoRoot, "THIRD_PARTY_NOTICES.md");
const sbomPath = path.join(repoRoot, "docs", "sbom.spdx.json");
const generatorName = "scripts/generate-license-evidence.mjs";
const spdxSourceInfoPrefix = "Validated source URL: ";
const selfTest = process.argv.includes("--self-test");
const checkOnly = process.argv.includes("--check") || selfTest;
const reviewedLicenseExpressions = new Set([
  "(MIT AND Zlib)",
  "(MPL-2.0 OR Apache-2.0)",
  "0BSD",
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "ISC",
  "LGPL-2.0-only",
  "LGPL-2.0-or-later",
  "LGPL-2.1-only",
  "LGPL-2.1-or-later",
  "LGPL-3.0-only",
  "LGPL-3.0-or-later",
  "MIT",
]);
const bundledRuntimeNoticeStart = "<!-- bundled-browser-runtime-licenses:start -->";
const bundledRuntimeNoticeEnd = "<!-- bundled-browser-runtime-licenses:end -->";
const bundledRuntimeLicenseContracts = [
  {
    name: "copc",
    version: "0.0.8",
    license: "MIT",
    sourcePath: "node_modules/copc/license",
    sha256: "8fb5b4508a39ae3e34be45065c2eacbd5353961870e98eba5906c256669fb794",
    provenance: "Exact license file distributed in the locked npm package.",
  },
  {
    name: "cross-fetch",
    version: "3.2.0",
    license: "MIT",
    sourcePath: "node_modules/cross-fetch/LICENSE",
    sha256: "821a6be45c3fd08815688b30b6210fc97848cf88c7a6ed8afb22ae75b83571b4",
    provenance: "Exact license file distributed in the locked npm package.",
  },
  {
    name: "laz-perf",
    version: "0.0.7",
    license: "Apache-2.0",
    sourcePath: "third_party/licenses/laz-perf-0.0.7-COPYING",
    sha256: "959f77033ba56a3b146faf5c02f9162071f2d0bff4b8b6f1c2193a4b41127d39",
    provenance:
      "Upstream COPYING at gitHead d0d3047e05221421fa0b02b3da4e93797edb2c52 " +
      "(https://github.com/hobuinc/laz-perf/blob/d0d3047e05221421fa0b02b3da4e93797edb2c52/COPYING); " +
      "the npm tarball omits this file.",
  },
  {
    name: "proj4",
    version: "2.20.9",
    license: "MIT",
    sourcePath: "node_modules/proj4/LICENSE.md",
    sha256: "d514fd8b286fc00a5c97a29f8a99b73f1a4053bbdd00c400aee5f24a1b6b301e",
    provenance: "Exact license file distributed in the locked npm package.",
  },
  {
    name: "mgrs",
    version: "1.0.0",
    license: "MIT",
    sourcePath: "node_modules/mgrs/license.md",
    sha256: "069adb09f8be7a8d31415c476b5e25ea2da2f5150e69e32ac69179826f9d33b5",
    provenance: "Exact license file distributed in the locked npm package.",
  },
  {
    name: "wkt-parser",
    version: "1.5.5",
    license: "MIT",
    sourcePath: "node_modules/wkt-parser/LICENSE.md",
    sha256: "d514fd8b286fc00a5c97a29f8a99b73f1a4053bbdd00c400aee5f24a1b6b301e",
    provenance: "Exact license file distributed in the locked npm package.",
  },
];

try {
  generateEvidence();
} catch (error) {
  console.error(`License evidence generation failed:\n${error.message}`);
  process.exitCode = 1;
}

function generateEvidence() {
  const rootPackage = readJson(packagePath);
  const lock = readJson(lockPath);

  if (!lock.packages || typeof lock.packages !== "object") {
    throw new Error("package-lock.json does not contain a packages inventory.");
  }

  validateRootPackageContract(rootPackage, lock);
  const policyErrors = validateLockedDependencyPolicy(lock);
  const installedPaths = discoverInstalledPackages(path.join(repoRoot, "node_modules"));
  const inventory = installedPaths.map((installPath) =>
    inspectInstalledPackage(installPath, lock, policyErrors),
  );

  if (policyErrors.length > 0) {
    throw new Error(
      `license policy rejected ${policyErrors.length} item(s):\n- ${policyErrors.join("\n- ")}`,
    );
  }

  const components = groupInstalledComponents(inventory);
  const rawSbom = runNpmSbom();
  validateSbom(rawSbom, rootPackage, components);

  if (checkOnly) {
    const committedEvidence = validateCommittedEvidence(rootPackage, lock);
    if (selfTest) {
      runEvidenceSelfTests(rootPackage, lock, committedEvidence);
    }
    console.log(
      `License evidence passed: ${inventory.length} installed package instance(s), ` +
        `${components.length} unique component(s), ${countLockedDependencies(lock)} locked record(s).`,
    );
    console.log(`${path.relative(repoRoot, noticesPath)}: verified`);
    console.log(`${path.relative(repoRoot, sbomPath)}: verified`);
    return;
  }

  const sbom = normalizeSbom(rawSbom, rootPackage, lock, components);
  const notices = renderNotices(lock, inventory, components, sbom, rootPackage);

  const noticesStatus = persistGeneratedFile(noticesPath, notices);
  const sbomStatus = persistGeneratedFile(
    sbomPath,
    `${JSON.stringify(canonicalize(sbom), null, 2)}\n`,
  );

  console.log(
    `License evidence passed: ${inventory.length} installed package instance(s), ` +
      `${components.length} unique component(s), ${countLockedDependencies(lock)} locked record(s).`,
  );
  console.log(`${path.relative(repoRoot, noticesPath)}: ${noticesStatus}`);
  console.log(`${path.relative(repoRoot, sbomPath)}: ${sbomStatus}`);
}

function validateLockedDependencyPolicy(lock) {
  const errors = [];

  for (const [installPath, entry] of sortedEntries(lock.packages)) {
    if (!isDependencyPath(installPath)) {
      continue;
    }

    const coordinate = `${packageNameFromInstallPath(installPath)}@${entry.version ?? "<missing>"}`;
    validateLicense(entry.license, `${coordinate} in package-lock.json`, errors);

    if (typeof entry.version !== "string" || entry.version.trim() === "") {
      errors.push(`${coordinate}: missing version in package-lock.json`);
    }

    validateHttpsUrl(entry.resolved, `${coordinate}: locked artifact URL`, errors);
    validateSha512Integrity(entry.integrity, `${coordinate}: locked artifact integrity`, errors);
  }

  return errors;
}

function validateRootPackageContract(rootPackage, lock) {
  const lockRoot = lock.packages?.[""];
  if (!lockRoot) {
    throw new Error("package-lock.json does not contain the root package record.");
  }

  for (const field of ["name", "version", "license"]) {
    if (rootPackage[field] !== lockRoot[field]) {
      throw new Error(
        `package.json ${field} does not match package-lock.json ` +
          `(${rootPackage[field] ?? "<missing>"} != ${lockRoot[field] ?? "<missing>"}).`,
      );
    }
  }

  const errors = [];
  validateLicense(rootPackage.license, `${rootPackage.name}@${rootPackage.version}`, errors);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
}

function inspectInstalledPackage(installPath, lock, errors) {
  const lockEntry = lock.packages[installPath];
  const manifestPath = path.join(repoRoot, installPath, "package.json");

  if (!lockEntry) {
    errors.push(`${installPath}: installed package is not represented in package-lock.json`);
  }

  const manifest = readJson(manifestPath);
  const coordinate = `${manifest.name ?? "<missing>"}@${manifest.version ?? "<missing>"}`;

  if (manifest.name !== packageNameFromInstallPath(installPath)) {
    errors.push(`${installPath}: package name does not match its install path (${manifest.name})`);
  }

  if (!lockEntry) {
    return {
      installPath,
      name: manifest.name,
      version: manifest.version,
      license: manifest.license,
      sourceUrl: "",
      artifactUrl: "",
      scopes: [],
    };
  }

  if (manifest.version !== lockEntry.version) {
    errors.push(
      `${coordinate}: node_modules version does not match package-lock.json (${lockEntry.version})`,
    );
  }

  validateLicense(manifest.license, `${coordinate} in node_modules`, errors);
  if (normalizeLicense(manifest.license) !== normalizeLicense(lockEntry.license)) {
    errors.push(
      `${coordinate}: license mismatch (node_modules=${manifest.license}, lock=${lockEntry.license})`,
    );
  }

  const sourceUrl = resolveSourceUrl(manifest, lockEntry.resolved);
  validateHttpsUrl(sourceUrl, `${coordinate}: source URL`, errors);

  return {
    installPath,
    name: manifest.name,
    version: manifest.version,
    license: normalizeLicense(lockEntry.license),
    sourceUrl,
    artifactUrl: lockEntry.resolved,
    scopes: dependencyScopes(lockEntry),
  };
}

function validateLicense(value, context, errors) {
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(`${context}: missing license declaration`);
    return;
  }

  const license = normalizeLicense(value);
  if (!reviewedLicenseExpressions.has(license)) {
    errors.push(
      `${context}: license expression "${license}" is not in the reviewed allowlist ` +
        `(${[...reviewedLicenseExpressions].join(", ")})`,
    );
  }
}

function validateSha512Integrity(value, context, errors) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    errors.push(`${context}: expected an npm sha512 integrity value`);
    return;
  }

  const decoded = Buffer.from(value.slice("sha512-".length), "base64");
  if (decoded.length !== 64) {
    errors.push(`${context}: decoded sha512 integrity must contain 64 bytes`);
  }
}

function discoverInstalledPackages(nodeModulesPath) {
  if (!existsSync(nodeModulesPath)) {
    throw new Error("node_modules is missing; run npm ci before generating license evidence.");
  }

  const found = [];
  const visited = new Set();

  function scan(directory) {
    if (!existsSync(directory)) {
      return;
    }

    const realDirectory = realpathSync(directory);
    if (visited.has(realDirectory)) {
      return;
    }
    visited.add(realDirectory);

    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(compareDirents)) {
      if (entry.name.startsWith(".")) {
        continue;
      }

      const entryPath = path.join(directory, entry.name);
      if (entry.name.startsWith("@") && entry.isDirectory()) {
        for (const scoped of readdirSync(entryPath, { withFileTypes: true }).sort(compareDirents)) {
          if (scoped.isDirectory() || scoped.isSymbolicLink()) {
            register(path.join(entryPath, scoped.name));
          }
        }
      } else if (entry.isDirectory() || entry.isSymbolicLink()) {
        register(entryPath);
      }
    }
  }

  function register(packageDirectory) {
    const manifestPath = path.join(packageDirectory, "package.json");
    if (!existsSync(manifestPath)) {
      return;
    }

    assertInsideRepo(packageDirectory);
    found.push(toPosixPath(path.relative(repoRoot, packageDirectory)));
    scan(path.join(packageDirectory, "node_modules"));
  }

  scan(nodeModulesPath);
  return [...new Set(found)].sort(compareText);
}

function groupInstalledComponents(inventory) {
  const groups = new Map();

  for (const item of inventory) {
    const key = [item.name, item.version, item.license, item.sourceUrl, item.artifactUrl].join("\u0000");
    const existing = groups.get(key);
    if (existing) {
      existing.installPaths.push(item.installPath);
      existing.scopes.push(...item.scopes);
    } else {
      groups.set(key, {
        name: item.name,
        version: item.version,
        license: item.license,
        sourceUrl: item.sourceUrl,
        artifactUrl: item.artifactUrl,
        installPaths: [item.installPath],
        scopes: [...item.scopes],
      });
    }
  }

  return [...groups.values()]
    .map((component) => ({
      ...component,
      installPaths: [...new Set(component.installPaths)].sort(compareText),
      scopes: [...new Set(component.scopes)].sort(compareText),
    }))
    .sort((a, b) =>
      compareText(a.name, b.name) ||
      compareText(a.version, b.version) ||
      compareText(a.installPaths[0], b.installPaths[0]),
    );
}

function runNpmSbom() {
  const npmCli = findNpmCli();
  const result = spawnSync(
    process.execPath,
    [npmCli, "sbom", "--sbom-format", "spdx", "--sbom-type", "library"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        NO_UPDATE_NOTIFIER: "1",
        npm_config_audit: "false",
        npm_config_fund: "false",
        npm_config_ignore_scripts: "true",
        npm_config_offline: "true",
        npm_config_update_notifier: "false",
      },
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
      timeout: 120_000,
      windowsHide: true,
    },
  );

  if (result.error) {
    throw new Error(`npm sbom could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`npm sbom exited ${result.status}: ${(result.stderr || "").trim()}`);
  }

  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`npm sbom returned invalid JSON: ${error.message}`);
  }
}

function findNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib64", "node_modules", "npm", "bin", "npm-cli.js"),
  ];

  const npmCli = candidates.find(
    (candidate) =>
      typeof candidate === "string" &&
      /npm-cli\.(?:c?js)$/i.test(candidate) &&
      existsSync(candidate),
  );

  if (!npmCli) {
    throw new Error("Could not locate npm-cli.js for the built-in npm sbom command.");
  }
  return npmCli;
}

function validateSbom(sbom, rootPackage, components) {
  if (sbom.spdxVersion !== "SPDX-2.3" || sbom.dataLicense !== "CC0-1.0") {
    throw new Error("npm sbom did not return an SPDX 2.3 document licensed CC0-1.0.");
  }
  if (!Array.isArray(sbom.packages)) {
    throw new Error("npm sbom did not return a packages array.");
  }

  const expected = new Map();
  for (const component of components) {
    const coordinate = componentCoordinate(component.name, component.version);
    if (expected.has(coordinate)) {
      throw new Error(`Validated inventory contains duplicate component coordinate ${coordinate}.`);
    }
    expected.set(coordinate, component);
  }
  const seen = new Set();
  let rootCount = 0;
  const spdxIds = new Set();

  for (const pkg of sbom.packages) {
    if (spdxIds.has(pkg.SPDXID)) {
      throw new Error(`npm sbom contains duplicate package SPDXID ${pkg.SPDXID}.`);
    }
    spdxIds.add(pkg.SPDXID);

    const coordinate = componentCoordinate(pkg.name, pkg.versionInfo);
    if (coordinate === componentCoordinate(rootPackage.name, rootPackage.version)) {
      rootCount += 1;
      if (pkg.licenseDeclared !== normalizeLicense(rootPackage.license)) {
        throw new Error("npm sbom root license does not match package.json.");
      }
      continue;
    }

    if (seen.has(coordinate)) {
      throw new Error(`npm sbom contains duplicate component coordinate ${coordinate}.`);
    }
    const component = expected.get(coordinate);
    if (!component) {
      throw new Error(`npm sbom contains an unexpected component: ${coordinate}`);
    }
    if (pkg.licenseDeclared !== component.license) {
      throw new Error(`${coordinate}: npm sbom license does not match the validated inventory.`);
    }
    if (pkg.downloadLocation !== component.artifactUrl) {
      throw new Error(`${coordinate}: npm sbom artifact URL does not match package-lock.json.`);
    }
    seen.add(coordinate);
  }

  const missing = [...expected.keys()].filter((coordinate) => !seen.has(coordinate));
  if (rootCount !== 1 || missing.length > 0) {
    throw new Error(
      `npm sbom coverage mismatch (rootCount=${rootCount}, missing=${missing.join(", ") || "none"}).`,
    );
  }
}

function normalizeSbom(sbom, rootPackage, lock, components) {
  const inventoryFingerprint = createLockFingerprint(lock);
  const bundledRuntimeLicenses = readBundledRuntimeLicenseSources();
  validateBundledRuntimeComponents(components, bundledRuntimeLicenses);
  const bundledRuntimeByCoordinate = new Map(
    bundledRuntimeLicenses.map((entry) => [entry.coordinate, entry]),
  );
  const componentSources = new Map(
    components.map((component) => [
      componentCoordinate(component.name, component.version),
      component.sourceUrl,
    ]),
  );

  sbom.documentNamespace =
    `https://github.com/KimDDong03/COPC-Cesium-PointCloud-Provider/sbom/spdx/` +
    `${encodeURIComponent(rootPackage.name)}-${encodeURIComponent(rootPackage.version)}-` +
    inventoryFingerprint;
  sbom.creationInfo.created = resolveSpdxCreationTime();
  sbom.creationInfo.creators = [
    ...new Set([...sbom.creationInfo.creators, `Tool: ${generatorName}`]),
  ].sort(compareText);
  sbom.documentDescribes?.sort(compareText);
  sbom.packages.sort((a, b) =>
    compareText(a.name, b.name) ||
    compareText(a.versionInfo, b.versionInfo) ||
    compareText(a.SPDXID, b.SPDXID),
  );
  for (const pkg of sbom.packages) {
    const coordinate = componentCoordinate(pkg.name, pkg.versionInfo);
    const sourceUrl = componentSources.get(coordinate);
    if (sourceUrl) {
      pkg.sourceInfo = `${spdxSourceInfoPrefix}${sourceUrl}`;
    }
    const bundledRuntimeLicense = bundledRuntimeByCoordinate.get(coordinate);
    if (bundledRuntimeLicense) {
      pkg.attributionTexts = [bundledRuntimeLicense.text];
      pkg.comment = createBundledRuntimeSpdxComment(bundledRuntimeLicense);
    }
    pkg.checksums?.sort((a, b) =>
      compareText(a.algorithm, b.algorithm) || compareText(a.checksumValue, b.checksumValue),
    );
    pkg.externalRefs?.sort((a, b) =>
      compareText(a.referenceCategory, b.referenceCategory) ||
      compareText(a.referenceType, b.referenceType) ||
      compareText(a.referenceLocator, b.referenceLocator),
    );
  }
  if (Array.isArray(sbom.relationships)) {
    sbom.relationships = [
      ...new Map(
        sbom.relationships.map((relationship) => [
          `${relationship.spdxElementId}\u0000${relationship.relationshipType}\u0000${relationship.relatedSpdxElement}`,
          relationship,
        ]),
      ).values(),
    ];
  }
  sbom.relationships?.sort((a, b) =>
    compareText(a.spdxElementId, b.spdxElementId) ||
    compareText(a.relationshipType, b.relationshipType) ||
    compareText(a.relatedSpdxElement, b.relatedSpdxElement),
  );
  return sbom;
}

function resolveSpdxCreationTime() {
  const sourceDateEpoch = process.env.SOURCE_DATE_EPOCH;
  if (sourceDateEpoch === undefined) {
    return new Date().toISOString();
  }

  if (!/^[1-9]\d*$/.test(sourceDateEpoch)) {
    throw new Error("SOURCE_DATE_EPOCH must be a positive integer when provided.");
  }

  const seconds = Number(sourceDateEpoch);
  const milliseconds = seconds * 1000;
  if (!Number.isSafeInteger(seconds) || !Number.isFinite(milliseconds)) {
    throw new Error("SOURCE_DATE_EPOCH is outside the supported JavaScript date range.");
  }

  const created = new Date(milliseconds);
  if (Number.isNaN(created.getTime())) {
    throw new Error("SOURCE_DATE_EPOCH is outside the supported JavaScript date range.");
  }
  return created.toISOString();
}

function readBundledRuntimeLicenseSources() {
  const seenCoordinates = new Set();
  return bundledRuntimeLicenseContracts.map((contract) => {
    const coordinate = componentCoordinate(contract.name, contract.version);
    if (seenCoordinates.has(coordinate)) {
      throw new Error(`Bundled runtime license contract is duplicated: ${coordinate}.`);
    }
    seenCoordinates.add(coordinate);

    const sourceFile = path.join(repoRoot, contract.sourcePath);
    if (!existsSync(sourceFile)) {
      throw new Error(
        `${coordinate}: bundled runtime license source is missing: ${contract.sourcePath}.`,
      );
    }

    const bytes = readFileSync(sourceFile);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== contract.sha256) {
      throw new Error(
        `${coordinate}: bundled runtime license source SHA-256 mismatch ` +
          `(${digest} != ${contract.sha256}) for ${contract.sourcePath}.`,
      );
    }

    const text = bytes.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(bytes)) {
      throw new Error(`${coordinate}: bundled runtime license source is not valid UTF-8.`);
    }
    if (text.includes("```")) {
      throw new Error(`${coordinate}: bundled runtime license source cannot contain a code fence.`);
    }

    return { ...contract, coordinate, text };
  });
}

function validateBundledRuntimeComponents(components, bundledRuntimeLicenses) {
  const componentsByCoordinate = new Map();
  for (const component of components) {
    const coordinate = componentCoordinate(component.name, component.version);
    const matches = componentsByCoordinate.get(coordinate) ?? [];
    matches.push(component);
    componentsByCoordinate.set(coordinate, matches);
  }

  for (const contract of bundledRuntimeLicenses) {
    const matches = componentsByCoordinate.get(contract.coordinate) ?? [];
    if (matches.length !== 1) {
      throw new Error(
        `${contract.coordinate}: expected exactly one bundled runtime component, found ${matches.length}.`,
      );
    }
    if (matches[0].license !== contract.license) {
      throw new Error(
        `${contract.coordinate}: bundled runtime license contract does not match the inventory ` +
          `(${contract.license} != ${matches[0].license}).`,
      );
    }
  }
}

function createBundledRuntimeSpdxComment(contract) {
  return (
    `Bundled into the browser runtime distribution. Exact license and copyright text is ` +
    `preserved in attributionTexts and THIRD_PARTY_NOTICES.md. Source: ${contract.sourcePath}; ` +
    `SHA-256: ${contract.sha256}. ${contract.provenance}`
  );
}

function renderBundledRuntimeLicenseSection(bundledRuntimeLicenses) {
  const blocks = bundledRuntimeLicenses.map((contract) => {
    const fencedText = contract.text.endsWith("\n") ? contract.text : `${contract.text}\n`;
    return `### ${code(contract.coordinate)}

- Declared license: ${code(contract.license)}
- Exact-text source: ${code(contract.sourcePath)}
- Source SHA-256: ${code(contract.sha256)}
- Provenance: ${contract.provenance}

\`\`\`text
${fencedText}\`\`\``;
  });

  return `## Bundled browser runtime license and copyright texts

The published browser runtime inlines the six components below. Their exact upstream license and
copyright texts are retained here so the distributed package carries the notices required by the
bundled code, independently of whether a consumer installs transitive dependency directories.

${bundledRuntimeNoticeStart}
${blocks.join("\n\n")}
${bundledRuntimeNoticeEnd}`;
}

function validateBundledRuntimeLicenseSection(notices, bundledRuntimeLicenses) {
  const startCount = notices.split(bundledRuntimeNoticeStart).length - 1;
  const endCount = notices.split(bundledRuntimeNoticeEnd).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      "THIRD_PARTY_NOTICES.md must contain exactly one bundled runtime license section.",
    );
  }

  const expected = renderBundledRuntimeLicenseSection(bundledRuntimeLicenses);
  if (!notices.includes(expected)) {
    throw new Error(
      "THIRD_PARTY_NOTICES.md bundled runtime license section does not match the validated exact texts.",
    );
  }
}

function validateBundledRuntimeSpdxPackages(spdxIndex, bundledRuntimeLicenses) {
  for (const contract of bundledRuntimeLicenses) {
    const pkg = spdxIndex.byCoordinate.get(contract.coordinate);
    if (!pkg) {
      throw new Error(`${contract.coordinate}: bundled runtime package is missing from committed SPDX.`);
    }
    if (pkg.licenseDeclared !== contract.license) {
      throw new Error(
        `${contract.coordinate}: bundled runtime SPDX license does not match the exact-text contract.`,
      );
    }
    if (
      !Array.isArray(pkg.attributionTexts) ||
      pkg.attributionTexts.length !== 1 ||
      pkg.attributionTexts[0] !== contract.text
    ) {
      throw new Error(
        `${contract.coordinate}: bundled runtime SPDX attribution text is missing or tampered.`,
      );
    }
    if (pkg.comment !== createBundledRuntimeSpdxComment(contract)) {
      throw new Error(`${contract.coordinate}: bundled runtime SPDX provenance is missing or tampered.`);
    }
  }
}

function renderNotices(lock, inventory, components, sbom, rootPackage) {
  const bundledRuntimeLicenses = readBundledRuntimeLicenseSources();
  validateBundledRuntimeComponents(components, bundledRuntimeLicenses);
  const rootEntry = findRootSpdxPackage(sbom, rootPackage);
  const spdxByCoordinate = new Map(
    sbom.packages
      .filter((pkg) => pkg !== rootEntry)
      .map((pkg) => [componentCoordinate(pkg.name, pkg.versionInfo), pkg]),
  );
  const rows = components.map((component) => {
    const coordinate = componentCoordinate(component.name, component.version);
    const spdxPackage = spdxByCoordinate.get(coordinate);
    if (!spdxPackage) {
      throw new Error(`${coordinate}: normalized SPDX component is missing while rendering notices.`);
    }

    const paths = component.installPaths.map((value) => code(value)).join("<br>");
    return (
      `| ${code(component.name)} | ${code(component.version)} | ${code(component.license)} | ` +
      `<${component.sourceUrl}> | <${component.artifactUrl}> | ${component.scopes.join(", ")} | ` +
      `${paths} | ${code(createSpdxComponentDigest(spdxPackage))} |`
    );
  });

  if (rows.length !== spdxByCoordinate.size) {
    throw new Error(
      `Notice/SPDX component count mismatch (${rows.length} != ${spdxByCoordinate.size}).`,
    );
  }

  return `# Third-Party Notices

This file is generated by \`${generatorName}\`. Do not edit it manually.

Lockfile SHA-256: \`${createLockFingerprint(lock)}\`

Component inventory SHA-256: \`${createSpdxInventoryDigest(sbom, rootEntry)}\`

Generation platform: \`${process.platform}-${process.arch}\`

The inventory below is derived from \`package-lock.json\` and the matching installed
\`node_modules/**/package.json\` manifests. It records ${inventory.length} installed package
instances grouped into ${components.length} unique name/version/source components. The license
gate also checks all ${countLockedDependencies(lock)} dependency records in the lockfile,
including platform-specific optional packages that are not installed on this machine.

## License policy

- Every locked and installed dependency must declare a non-empty license, version, and HTTPS artifact URL.
- Installed manifest name, version, and license must match \`package-lock.json\` exactly.
- Every license expression must exactly match the reviewed allowlist: ${[...reviewedLicenseExpressions].map(code).join(", ")}.
- The listed SPDX LGPL forms remain allowed by project policy; any other new or unreviewed expression fails until it is explicitly added.
- Every non-optional lock coordinate must be present in the committed SPDX document. Platform-specific optional coordinates may be absent, but any that are present must exactly match the lockfile.
- SPDX package identifiers, coordinates, checksums, and relationships are checked for uniqueness, valid endpoints, and connectivity to the root package.
- This notice table must contain exactly one row for every committed non-root SPDX package. The per-row and inventory SHA-256 values bind it to the SPDX document.
- The committed SPDX 2.3 document is produced by npm's built-in \`npm sbom\` command, then normalized for stable ordering. Its default creation time records the actual generation UTC; a positive \`SOURCE_DATE_EPOCH\` may be supplied for a reproducible timestamp.
- Browser-runtime dependencies that are inlined into the published bundle must retain their exact validated license and copyright texts in both the SPDX attribution data and the bundled-runtime section below.

## Dependency inventory

| Name | Version | Declared license | Source URL | Locked artifact URL | Scope | Installed path(s) | SPDX package SHA-256 |
| --- | --- | --- | --- | --- | --- | --- | --- |
${rows.join("\n")}

${renderBundledRuntimeLicenseSection(bundledRuntimeLicenses)}
`;
}

function validateCommittedEvidence(rootPackage, lock) {
  if (!existsSync(noticesPath) || !existsSync(sbomPath)) {
    throw new Error(
      "Committed license evidence is missing; run npm run license:evidence and commit the result.",
    );
  }

  const fingerprint = createLockFingerprint(lock);
  const notices = readFileSync(noticesPath, "utf8");
  const sbom = readJson(sbomPath);

  validateCommittedEvidenceContent(rootPackage, lock, notices, sbom);
  return { notices, sbom };
}

function validateCommittedEvidenceContent(rootPackage, lock, notices, sbom) {
  const fingerprint = createLockFingerprint(lock);

  if (!notices.includes(`Lockfile SHA-256: \`${fingerprint}\``)) {
    throw new Error(
      "THIRD_PARTY_NOTICES.md does not match package-lock.json; run npm run license:evidence.",
    );
  }

  if (
    sbom.spdxVersion !== "SPDX-2.3" ||
    sbom.dataLicense !== "CC0-1.0" ||
    !sbom.documentNamespace?.endsWith(`-${fingerprint}`)
  ) {
    throw new Error(
      "docs/sbom.spdx.json does not match package-lock.json or the SPDX 2.3 contract; run npm run license:evidence.",
    );
  }

  validateSpdxCreationInfo(sbom);
  const bundledRuntimeLicenses = readBundledRuntimeLicenseSources();
  const lockIndex = buildLockCoordinateIndex(lock);
  const spdxIndex = validateCommittedSpdx(rootPackage, lockIndex, sbom);
  validateBundledRuntimeSpdxPackages(spdxIndex, bundledRuntimeLicenses);
  validateBundledRuntimeLicenseSection(notices, bundledRuntimeLicenses);
  validateNoticeInventory(notices, lockIndex, spdxIndex);
}

function validateSpdxCreationInfo(sbom) {
  const created = sbom.creationInfo?.created;
  const milliseconds = typeof created === "string" ? Date.parse(created) : Number.NaN;
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds <= 0 ||
    new Date(milliseconds).toISOString() !== created
  ) {
    throw new Error(
      "Committed SPDX creation timestamp must be a canonical, positive UTC instant.",
    );
  }

  if (
    !Array.isArray(sbom.creationInfo?.creators) ||
    !sbom.creationInfo.creators.includes(`Tool: ${generatorName}`)
  ) {
    throw new Error("Committed SPDX creationInfo does not identify the license evidence generator.");
  }
}

function buildLockCoordinateIndex(lock) {
  const index = new Map();

  for (const [installPath, entry] of sortedEntries(lock.packages)) {
    if (!isDependencyPath(installPath)) {
      continue;
    }

    const name = packageNameFromInstallPath(installPath);
    const version = entry.version;
    const coordinate = componentCoordinate(name, version);
    const license = normalizeLicense(entry.license);
    const existing = index.get(coordinate);

    if (existing) {
      for (const [field, value] of [
        ["license", license],
        ["artifact URL", entry.resolved],
        ["integrity", entry.integrity],
      ]) {
        const property =
          field === "artifact URL" ? "artifactUrl" : field === "integrity" ? "integrity" : field;
        if (existing[property] !== value) {
          throw new Error(
            `${coordinate}: lock records disagree on ${field} ` +
              `(${existing[property] ?? "<missing>"} != ${value ?? "<missing>"}).`,
          );
        }
      }
      existing.required ||= !entry.optional;
      existing.paths.set(installPath, dependencyScopes(entry));
      continue;
    }

    index.set(coordinate, {
      name,
      version,
      license,
      artifactUrl: entry.resolved,
      integrity: entry.integrity,
      required: !entry.optional,
      paths: new Map([[installPath, dependencyScopes(entry)]]),
    });
  }

  return index;
}

function validateCommittedSpdx(rootPackage, lockIndex, sbom) {
  if (sbom.SPDXID !== "SPDXRef-DOCUMENT") {
    throw new Error(`Committed SPDX document has an invalid SPDXID: ${sbom.SPDXID ?? "<missing>"}.`);
  }
  if (!Array.isArray(sbom.packages) || sbom.packages.length === 0) {
    throw new Error("Committed SPDX document does not contain a packages inventory.");
  }

  const rootCoordinate = componentCoordinate(rootPackage.name, rootPackage.version);
  const byId = new Map();
  const byCoordinate = new Map();
  let rootEntry;

  for (const pkg of sbom.packages) {
    if (typeof pkg.SPDXID !== "string" || !pkg.SPDXID.startsWith("SPDXRef-")) {
      throw new Error(`Committed SPDX package has an invalid SPDXID: ${pkg.SPDXID ?? "<missing>"}.`);
    }
    if (byId.has(pkg.SPDXID)) {
      throw new Error(`Committed SPDX contains duplicate package SPDXID ${pkg.SPDXID}.`);
    }
    byId.set(pkg.SPDXID, pkg);

    if (typeof pkg.name !== "string" || typeof pkg.versionInfo !== "string") {
      throw new Error(`${pkg.SPDXID}: committed SPDX package is missing name or versionInfo.`);
    }

    const coordinate = componentCoordinate(pkg.name, pkg.versionInfo);
    const errors = [];
    validateLicense(pkg.licenseDeclared, `${coordinate} in committed SPDX`, errors);
    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }

    if (coordinate === rootCoordinate) {
      if (rootEntry) {
        throw new Error(`Committed SPDX contains duplicate root package coordinate ${coordinate}.`);
      }
      if (pkg.licenseDeclared !== normalizeLicense(rootPackage.license)) {
        throw new Error(`${coordinate}: committed SPDX root license does not match package.json.`);
      }
      rootEntry = pkg;
      continue;
    }

    if (byCoordinate.has(coordinate)) {
      throw new Error(`Committed SPDX contains duplicate component coordinate ${coordinate}.`);
    }

    const locked = lockIndex.get(coordinate);
    if (!locked) {
      throw new Error(`Committed SPDX contains an unexpected component: ${coordinate}.`);
    }

    if (pkg.licenseDeclared !== locked.license) {
      throw new Error(`${coordinate}: committed SPDX license does not exactly match package-lock.json.`);
    }
    if (pkg.downloadLocation !== locked.artifactUrl) {
      throw new Error(
        `${coordinate}: committed SPDX downloadLocation does not exactly match package-lock.json.`,
      );
    }

    readSpdxSourceUrl(pkg, coordinate);
    validateSpdxChecksum(pkg, locked);
    if (!locked.paths.has(pkg.packageFileName)) {
      throw new Error(
        `${coordinate}: committed SPDX packageFileName is not a matching lock path ` +
          `(${pkg.packageFileName ?? "<missing>"}).`,
      );
    }
    byCoordinate.set(coordinate, pkg);
  }

  if (!rootEntry) {
    throw new Error("docs/sbom.spdx.json does not describe the root package.");
  }

  const missingRequired = [...lockIndex.entries()]
    .filter(([coordinate, entry]) => entry.required && !byCoordinate.has(coordinate))
    .map(([coordinate]) => coordinate)
    .sort(compareText);
  if (missingRequired.length > 0) {
    throw new Error(
      `Committed SPDX is missing required lock coordinate(s): ${missingRequired.join(", ")}.`,
    );
  }

  validateSpdxRelationships(sbom, rootEntry, byId);
  return { rootEntry, byCoordinate, byId, sbom };
}

function validateSpdxChecksum(pkg, locked) {
  if (!Array.isArray(pkg.checksums) || pkg.checksums.length !== 1) {
    throw new Error(
      `${componentCoordinate(pkg.name, pkg.versionInfo)}: committed SPDX must contain exactly one checksum.`,
    );
  }

  const checksum = pkg.checksums[0];
  const expected = Buffer.from(locked.integrity.slice("sha512-".length), "base64").toString("hex");
  if (checksum.algorithm !== "SHA512" || checksum.checksumValue !== expected) {
    throw new Error(
      `${componentCoordinate(pkg.name, pkg.versionInfo)}: committed SPDX checksum does not exactly match package-lock.json.`,
    );
  }
}

function validateSpdxRelationships(sbom, rootEntry, byId) {
  if (
    !Array.isArray(sbom.documentDescribes) ||
    sbom.documentDescribes.length !== 1 ||
    sbom.documentDescribes[0] !== rootEntry.SPDXID
  ) {
    throw new Error("Committed SPDX documentDescribes must contain only the root package SPDXID.");
  }
  if (!Array.isArray(sbom.relationships) || sbom.relationships.length === 0) {
    throw new Error("Committed SPDX document does not contain relationships.");
  }

  const validEndpoints = new Set([sbom.SPDXID, ...byId.keys()]);
  const relationshipKeys = new Set();
  const adjacency = new Map([...byId.keys()].map((id) => [id, new Set()]));
  let describesCount = 0;

  for (const relationship of sbom.relationships) {
    const { spdxElementId, relationshipType, relatedSpdxElement } = relationship;
    if (!validEndpoints.has(spdxElementId) || !validEndpoints.has(relatedSpdxElement)) {
      throw new Error(
        `Committed SPDX relationship has an unknown relationship endpoint: ` +
          `${spdxElementId ?? "<missing>"} -> ${relatedSpdxElement ?? "<missing>"}.`,
      );
    }
    if (spdxElementId === relatedSpdxElement) {
      throw new Error(`Committed SPDX relationship contains a self-reference: ${spdxElementId}.`);
    }
    if (typeof relationshipType !== "string" || relationshipType === "") {
      throw new Error("Committed SPDX relationship is missing relationshipType.");
    }

    const key = `${spdxElementId}\u0000${relationshipType}\u0000${relatedSpdxElement}`;
    if (relationshipKeys.has(key)) {
      throw new Error(`Committed SPDX contains duplicate relationship ${key.replaceAll("\u0000", " ")}.`);
    }
    relationshipKeys.add(key);

    if (relationshipType === "DESCRIBES") {
      if (spdxElementId !== sbom.SPDXID || relatedSpdxElement !== rootEntry.SPDXID) {
        throw new Error("Committed SPDX contains a DESCRIBES relationship outside document -> root.");
      }
      describesCount += 1;
    }

    if (byId.has(spdxElementId) && byId.has(relatedSpdxElement)) {
      adjacency.get(spdxElementId).add(relatedSpdxElement);
      adjacency.get(relatedSpdxElement).add(spdxElementId);
    }
  }

  if (describesCount !== 1) {
    throw new Error(`Committed SPDX must contain exactly one document -> root DESCRIBES relationship.`);
  }

  const reachable = new Set([rootEntry.SPDXID]);
  const queue = [rootEntry.SPDXID];
  while (queue.length > 0) {
    const current = queue.shift();
    for (const neighbor of adjacency.get(current) ?? []) {
      if (!reachable.has(neighbor)) {
        reachable.add(neighbor);
        queue.push(neighbor);
      }
    }
  }

  const disconnected = [...byId.keys()].filter((id) => !reachable.has(id)).sort(compareText);
  if (disconnected.length > 0) {
    throw new Error(
      `Committed SPDX package relationship graph is disconnected from the root: ` +
        `${disconnected.join(", ")}.`,
    );
  }
}

function validateNoticeInventory(notices, lockIndex, spdxIndex) {
  const expectedInventoryDigest = createSpdxInventoryDigest(
    spdxIndex.sbom,
    spdxIndex.rootEntry,
  );
  const digestMatch = notices.match(/Component inventory SHA-256: `([0-9a-f]{64})`/);
  if (!digestMatch || digestMatch[1] !== expectedInventoryDigest) {
    throw new Error("THIRD_PARTY_NOTICES.md component inventory digest does not match committed SPDX.");
  }

  const rows = parseNoticeRows(notices);
  const byCoordinate = new Map();
  for (const row of rows) {
    const coordinate = componentCoordinate(row.name, row.version);
    if (byCoordinate.has(coordinate)) {
      throw new Error(`THIRD_PARTY_NOTICES.md contains duplicate component row ${coordinate}.`);
    }
    byCoordinate.set(coordinate, row);
  }

  const expectedCoordinates = [...spdxIndex.byCoordinate.keys()].sort(compareText);
  const actualCoordinates = [...byCoordinate.keys()].sort(compareText);
  if (JSON.stringify(actualCoordinates) !== JSON.stringify(expectedCoordinates)) {
    const missing = expectedCoordinates.filter((coordinate) => !byCoordinate.has(coordinate));
    const unexpected = actualCoordinates.filter(
      (coordinate) => !spdxIndex.byCoordinate.has(coordinate),
    );
    throw new Error(
      `THIRD_PARTY_NOTICES.md notice inventory coverage mismatch ` +
        `(missing=${missing.join(", ") || "none"}; unexpected=${unexpected.join(", ") || "none"}).`,
    );
  }

  for (const coordinate of expectedCoordinates) {
    const row = byCoordinate.get(coordinate);
    const pkg = spdxIndex.byCoordinate.get(coordinate);
    const locked = lockIndex.get(coordinate);
    if (
      row.license !== pkg.licenseDeclared ||
      row.sourceUrl !== readSpdxSourceUrl(pkg, coordinate) ||
      row.artifactUrl !== pkg.downloadLocation
    ) {
      throw new Error(
        `${coordinate}: notice license, source URL, or artifact URL does not match committed SPDX.`,
      );
    }
    if (row.componentDigest !== createSpdxComponentDigest(pkg)) {
      throw new Error(`${coordinate}: notice component digest does not match committed SPDX.`);
    }

    const urlErrors = [];
    validateHttpsUrl(row.sourceUrl, `${coordinate}: notice source URL`, urlErrors);
    if (urlErrors.length > 0) {
      throw new Error(urlErrors.join("\n"));
    }

    if (row.installPaths.length === 0 || new Set(row.installPaths).size !== row.installPaths.length) {
      throw new Error(`${coordinate}: notice installed paths must be non-empty and unique.`);
    }
    for (const installPath of row.installPaths) {
      if (!locked.paths.has(installPath)) {
        throw new Error(`${coordinate}: notice contains a path not represented by the lock coordinate.`);
      }
    }
    if (!row.installPaths.includes(pkg.packageFileName)) {
      throw new Error(`${coordinate}: notice paths do not include the committed SPDX packageFileName.`);
    }

    const expectedScopes = [
      ...new Set(row.installPaths.flatMap((installPath) => locked.paths.get(installPath))),
    ].sort(compareText);
    if (JSON.stringify(row.scopes) !== JSON.stringify(expectedScopes)) {
      throw new Error(`${coordinate}: notice scope does not match the listed lock path(s).`);
    }
  }
}

function parseNoticeRows(notices) {
  const header =
    "| Name | Version | Declared license | Source URL | Locked artifact URL | Scope | " +
    "Installed path(s) | SPDX package SHA-256 |";
  const lines = notices.replaceAll("\r\n", "\n").split("\n");
  const headerIndex = lines.indexOf(header);
  if (headerIndex < 0 || !/^\|(?: --- \|){8}$/.test(lines[headerIndex + 1] ?? "")) {
    throw new Error("THIRD_PARTY_NOTICES.md dependency inventory table contract is missing.");
  }

  const rows = [];
  for (const line of lines.slice(headerIndex + 2)) {
    if (!line.startsWith("| ")) {
      break;
    }
    if (!line.endsWith(" |")) {
      throw new Error("THIRD_PARTY_NOTICES.md contains a malformed dependency row.");
    }
    const cells = line.slice(2, -2).split(" | ");
    if (cells.length !== 8) {
      throw new Error("THIRD_PARTY_NOTICES.md dependency row must contain exactly 8 columns.");
    }

    rows.push({
      name: parseCodeCell(cells[0], "name"),
      version: parseCodeCell(cells[1], "version"),
      license: parseCodeCell(cells[2], "license"),
      sourceUrl: parseLinkCell(cells[3], "source URL"),
      artifactUrl: parseLinkCell(cells[4], "artifact URL"),
      scopes: cells[5].split(", ").filter(Boolean).sort(compareText),
      installPaths: cells[6]
        .split("<br>")
        .map((cell) => parseCodeCell(cell, "installed path")),
      componentDigest: parseCodeCell(cells[7], "SPDX package SHA-256"),
    });
  }
  return rows;
}

function parseCodeCell(value, label) {
  if (!value.startsWith("`") || !value.endsWith("`")) {
    throw new Error(`THIRD_PARTY_NOTICES.md ${label} cell is not inline code.`);
  }
  return value.slice(1, -1).replaceAll("\\`", "`");
}

function parseLinkCell(value, label) {
  if (!value.startsWith("<") || !value.endsWith(">")) {
    throw new Error(`THIRD_PARTY_NOTICES.md ${label} cell is not an autolink.`);
  }
  return value.slice(1, -1);
}

function findRootSpdxPackage(sbom, rootPackage) {
  const matches = (sbom.packages ?? []).filter(
    (entry) => entry.name === rootPackage.name && entry.versionInfo === rootPackage.version,
  );
  if (matches.length !== 1) {
    throw new Error(`SPDX root package coverage mismatch (found ${matches.length}, expected 1).`);
  }
  return matches[0];
}

function createSpdxComponentDescriptor(pkg) {
  return {
    spdxId: pkg.SPDXID,
    name: pkg.name,
    version: pkg.versionInfo,
    license: pkg.licenseDeclared,
    sourceInfo: pkg.sourceInfo,
    artifactUrl: pkg.downloadLocation,
    packageFileName: pkg.packageFileName,
    comment: pkg.comment,
    attributionTexts: pkg.attributionTexts,
    checksums: (pkg.checksums ?? [])
      .map((checksum) => ({
        algorithm: checksum.algorithm,
        checksumValue: checksum.checksumValue,
      }))
      .sort((a, b) =>
        compareText(a.algorithm, b.algorithm) || compareText(a.checksumValue, b.checksumValue),
      ),
  };
}

function readSpdxSourceUrl(pkg, coordinate) {
  if (
    typeof pkg.sourceInfo !== "string" ||
    !pkg.sourceInfo.startsWith(spdxSourceInfoPrefix)
  ) {
    throw new Error(`${coordinate}: committed SPDX sourceInfo contract is missing.`);
  }

  const sourceUrl = pkg.sourceInfo.slice(spdxSourceInfoPrefix.length);
  const errors = [];
  validateHttpsUrl(sourceUrl, `${coordinate}: committed SPDX source URL`, errors);
  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }
  return sourceUrl;
}

function createSpdxComponentDigest(pkg) {
  return createCanonicalDigest(createSpdxComponentDescriptor(pkg));
}

function createSpdxInventoryDigest(sbom, rootEntry) {
  const descriptors = sbom.packages
    .filter((pkg) => pkg.SPDXID !== rootEntry.SPDXID)
    .map(createSpdxComponentDescriptor)
    .sort((a, b) =>
      compareText(a.name, b.name) ||
      compareText(a.version, b.version) ||
      compareText(a.spdxId, b.spdxId),
    );
  return createCanonicalDigest(descriptors);
}

function createCanonicalDigest(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

function componentCoordinate(name, version) {
  return `${name ?? "<missing>"}@${version ?? "<missing>"}`;
}

function runEvidenceSelfTests(rootPackage, lock, committedEvidence) {
  const { notices, sbom } = committedEvidence;
  const bundledRuntimeLicenses = readBundledRuntimeLicenseSources();
  const lockIndex = buildLockCoordinateIndex(lock);
  const rootEntry = findRootSpdxPackage(sbom, rootPackage);
  const requiredCoordinate = [...lockIndex.entries()].find(
    ([coordinate, entry]) =>
      entry.required &&
      sbom.packages.some(
        (pkg) => componentCoordinate(pkg.name, pkg.versionInfo) === coordinate,
      ),
  )?.[0];
  const target = sbom.packages.find(
    (pkg) => componentCoordinate(pkg.name, pkg.versionInfo) === requiredCoordinate,
  );
  if (!requiredCoordinate || !target) {
    throw new Error("License evidence self-test could not select a required dependency package.");
  }

  const optionalOnlyCoordinates = new Set(
    [...lockIndex.entries()]
      .filter(([, entry]) => !entry.required)
      .map(([coordinate]) => coordinate),
  );
  const presentOptionalIds = new Set(
    sbom.packages
      .filter((pkg) => optionalOnlyCoordinates.has(componentCoordinate(pkg.name, pkg.versionInfo)))
      .map((pkg) => pkg.SPDXID),
  );
  if (presentOptionalIds.size > 0) {
    const withoutPlatformOptionals = structuredClone(sbom);
    withoutPlatformOptionals.packages = withoutPlatformOptionals.packages.filter(
      (pkg) => !presentOptionalIds.has(pkg.SPDXID),
    );
    withoutPlatformOptionals.relationships = withoutPlatformOptionals.relationships.filter(
      (relationship) =>
        !presentOptionalIds.has(relationship.spdxElementId) &&
        !presentOptionalIds.has(relationship.relatedSpdxElement),
    );

    const reducedRoot = findRootSpdxPackage(withoutPlatformOptionals, rootPackage);
    const reducedDigest = createSpdxInventoryDigest(withoutPlatformOptionals, reducedRoot);
    const withoutOptionalRows = notices
      .replace(/Component inventory SHA-256: `[0-9a-f]{64}`/, `Component inventory SHA-256: \`${reducedDigest}\``)
      .replaceAll("\r\n", "\n")
      .split("\n")
      .filter((line) => {
        if (!line.startsWith("| `") || !line.endsWith(" |")) {
          return true;
        }
        const cells = line.slice(2, -2).split(" | ");
        return !optionalOnlyCoordinates.has(
          componentCoordinate(parseCodeCell(cells[0], "name"), parseCodeCell(cells[1], "version")),
        );
      })
      .join("\n");
    validateCommittedEvidenceContent(
      rootPackage,
      lock,
      withoutOptionalRows,
      withoutPlatformOptionals,
    );
  }

  const deletedPackage = structuredClone(sbom);
  deletedPackage.packages = deletedPackage.packages.filter(
    (pkg) => pkg.SPDXID !== target.SPDXID,
  );
  deletedPackage.relationships = deletedPackage.relationships.filter(
    (relationship) =>
      relationship.spdxElementId !== target.SPDXID &&
      relationship.relatedSpdxElement !== target.SPDXID,
  );
  expectEvidenceFailure(
    "required SPDX package deletion",
    /missing required lock coordinate/i,
    () => validateCommittedEvidenceContent(rootPackage, lock, notices, deletedPackage),
  );

  const tamperedLicense = structuredClone(sbom);
  tamperedLicense.packages.find((pkg) => pkg.SPDXID === target.SPDXID).licenseDeclared =
    "BSD-4-Clause";
  expectEvidenceFailure(
    "unreviewed license tampering",
    /not in the reviewed allowlist/i,
    () => validateCommittedEvidenceContent(rootPackage, lock, notices, tamperedLicense),
  );

  const unknownPackage = structuredClone(sbom);
  const unknown = structuredClone(target);
  unknown.SPDXID = "SPDXRef-Package-self-test-unknown-1.0.0";
  unknown.name = "self-test-unknown";
  unknown.versionInfo = "1.0.0";
  unknown.packageFileName = "node_modules/self-test-unknown";
  unknownPackage.packages.push(unknown);
  unknownPackage.relationships.push({
    spdxElementId: unknown.SPDXID,
    relationshipType: "DEPENDENCY_OF",
    relatedSpdxElement: rootEntry.SPDXID,
  });
  expectEvidenceFailure(
    "unknown SPDX package injection",
    /unexpected component/i,
    () => validateCommittedEvidenceContent(rootPackage, lock, notices, unknownPackage),
  );

  const duplicateCoordinate = structuredClone(sbom);
  const duplicate = structuredClone(target);
  duplicate.SPDXID = `${target.SPDXID}-self-test-duplicate`;
  duplicateCoordinate.packages.push(duplicate);
  duplicateCoordinate.relationships.push({
    spdxElementId: duplicate.SPDXID,
    relationshipType: "DEPENDENCY_OF",
    relatedSpdxElement: rootEntry.SPDXID,
  });
  expectEvidenceFailure(
    "duplicate SPDX coordinate injection",
    /duplicate component coordinate/i,
    () => validateCommittedEvidenceContent(rootPackage, lock, notices, duplicateCoordinate),
  );

  const brokenRelationship = structuredClone(sbom);
  const relationship = brokenRelationship.relationships.find(
    (candidate) => candidate.relationshipType !== "DESCRIBES",
  );
  relationship.relatedSpdxElement = "SPDXRef-Package-self-test-missing-endpoint";
  expectEvidenceFailure(
    "relationship endpoint tampering",
    /unknown relationship endpoint/i,
    () => validateCommittedEvidenceContent(rootPackage, lock, notices, brokenRelationship),
  );

  const epochZeroCreation = structuredClone(sbom);
  epochZeroCreation.creationInfo.created = "1970-01-01T00:00:00.000Z";
  expectEvidenceFailure(
    "epoch-zero SPDX creation timestamp",
    /creation timestamp/i,
    () => validateCommittedEvidenceContent(rootPackage, lock, notices, epochZeroCreation),
  );

  const bundledSection = renderBundledRuntimeLicenseSection(bundledRuntimeLicenses);
  const missingBundledSection = notices.replace(`${bundledSection}\n`, "");
  expectEvidenceFailure(
    "bundled runtime license section deletion",
    /exactly one bundled runtime license section/i,
    () => validateCommittedEvidenceContent(rootPackage, lock, missingBundledSection, sbom),
  );

  const firstBundledLicense = bundledRuntimeLicenses[0];
  const tamperedBundledNotice = notices.replace(
    firstBundledLicense.text,
    firstBundledLicense.text.replace("Copyright", "Tampered copyright"),
  );
  expectEvidenceFailure(
    "bundled runtime notice text tampering",
    /bundled runtime license section does not match/i,
    () => validateCommittedEvidenceContent(rootPackage, lock, tamperedBundledNotice, sbom),
  );

  const tamperedBundledSpdx = structuredClone(sbom);
  const bundledSpdxPackage = tamperedBundledSpdx.packages.find(
    (pkg) =>
      componentCoordinate(pkg.name, pkg.versionInfo) === firstBundledLicense.coordinate,
  );
  if (!bundledSpdxPackage) {
    throw new Error("License evidence self-test could not select a bundled runtime SPDX package.");
  }
  bundledSpdxPackage.attributionTexts[0] = bundledSpdxPackage.attributionTexts[0].replace(
    "Copyright",
    "Tampered copyright",
  );
  expectEvidenceFailure(
    "bundled runtime SPDX attribution tampering",
    /SPDX attribution text is missing or tampered/i,
    () => validateCommittedEvidenceContent(rootPackage, lock, notices, tamperedBundledSpdx),
  );

  const normalizedNotices = notices.replaceAll("\r\n", "\n");
  const firstNoticeRow = normalizedNotices
    .split("\n")
    .find((line) => line.startsWith("| `"));
  if (!firstNoticeRow) {
    throw new Error("License evidence self-test could not select a notice inventory row.");
  }
  const deletedNoticeRow = normalizedNotices.replace(`${firstNoticeRow}\n`, "");
  expectEvidenceFailure(
    "notice component row deletion",
    /notice inventory coverage mismatch/i,
    () => validateCommittedEvidenceContent(rootPackage, lock, deletedNoticeRow, sbom),
  );

  const tamperedNoticeRow = firstNoticeRow.replace(
    /<https:[^>]+>/,
    "<https://example.invalid/self-test-tampering>",
  );
  const tamperedNotice = normalizedNotices.replace(firstNoticeRow, tamperedNoticeRow);
  expectEvidenceFailure(
    "notice source URL tampering",
    /notice license, source URL, or artifact URL does not match/i,
    () => validateCommittedEvidenceContent(rootPackage, lock, tamperedNotice, sbom),
  );

  console.log(
    `License evidence self-test passed: 11 in-memory mutation scenario(s) rejected; ` +
      `${presentOptionalIds.size} platform-optional component(s) may be absent.`,
  );
}

function expectEvidenceFailure(label, expectedMessage, operation) {
  try {
    operation();
  } catch (error) {
    if (expectedMessage.test(error.message)) {
      return;
    }
    throw new Error(
      `License evidence self-test "${label}" failed for the wrong reason: ${error.message}`,
    );
  }
  throw new Error(`License evidence self-test "${label}" unexpectedly passed.`);
}

function createLockFingerprint(lock) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(lock)))
    .digest("hex");
}

function resolveSourceUrl(manifest, fallbackUrl) {
  const repository =
    typeof manifest.repository === "string"
      ? manifest.repository
      : manifest.repository?.url;
  let candidate = repository?.trim();

  if (candidate) {
    if (/^[\w.-]+\/[\w.-]+(?:#.*)?$/.test(candidate)) {
      candidate = `https://github.com/${candidate}`;
    } else if (candidate.startsWith("github:")) {
      candidate = `https://github.com/${candidate.slice("github:".length)}`;
    } else if (/^git@github\.com:/i.test(candidate)) {
      candidate = `https://github.com/${candidate.replace(/^git@github\.com:/i, "")}`;
    } else if (/^git\+https:/i.test(candidate)) {
      candidate = candidate.slice(4);
    } else if (/^git:\/\/github\.com\//i.test(candidate)) {
      candidate = candidate.replace(/^git:\/\/github\.com\//i, "https://github.com/");
    }
    candidate = candidate.replace(/\.git(?=$|#)/, "");
  }

  if (isHttpsUrl(candidate)) {
    return candidate;
  }
  if (isHttpsUrl(manifest.homepage)) {
    return manifest.homepage;
  }
  return fallbackUrl;
}

function validateHttpsUrl(value, context, errors) {
  if (!isHttpsUrl(value)) {
    errors.push(`${context}: expected an HTTPS URL, received "${value ?? "<missing>"}"`);
  }
}

function isHttpsUrl(value) {
  if (typeof value !== "string") {
    return false;
  }
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function dependencyScopes(entry) {
  const scopes = [entry.dev ? "development" : "runtime"];
  if (entry.optional) scopes.push("optional");
  if (entry.peer) scopes.push("peer");
  return scopes;
}

function countLockedDependencies(lock) {
  return Object.keys(lock.packages).filter(isDependencyPath).length;
}

function packageNameFromInstallPath(installPath) {
  return installPath.slice(installPath.lastIndexOf("node_modules/") + "node_modules/".length);
}

function isDependencyPath(installPath) {
  return installPath !== "" && installPath.includes("node_modules/");
}

function normalizeLicense(value) {
  return typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new Error(`Could not read ${path.relative(repoRoot, filePath)}: ${error.message}`);
  }
}

function writeIfChanged(filePath, content) {
  if (existsSync(filePath) && readFileSync(filePath, "utf8") === content) {
    return false;
  }
  writeFileSync(filePath, content, "utf8");
  return true;
}

function persistGeneratedFile(filePath, content) {
  if (checkOnly) {
    if (!existsSync(filePath) || readFileSync(filePath, "utf8") !== content) {
      throw new Error(
        `${path.relative(repoRoot, filePath)} is stale; run npm run license:evidence and commit the result.`,
      );
    }

    return "verified";
  }

  return writeIfChanged(filePath, content) ? "updated" : "unchanged";
}

function assertInsideRepo(target) {
  const relative = path.relative(repoRoot, realpathSync(target));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Refusing to inspect a package outside the repository: ${target}`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort(compareText)
        .map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

function sortedEntries(value) {
  return Object.entries(value).sort(([a], [b]) => compareText(a, b));
}

function compareDirents(a, b) {
  return compareText(a.name, b.name);
}

function compareText(a = "", b = "") {
  return a < b ? -1 : a > b ? 1 : 0;
}

function toPosixPath(value) {
  return value.replaceAll("\\", "/");
}

function code(value) {
  return `\`${String(value).replaceAll("`", "\\`")}\``;
}
