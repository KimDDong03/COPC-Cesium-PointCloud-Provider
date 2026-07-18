import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, "..");

const forbiddenInfrastructurePaths = [
  "deploy",
  "scripts/deployed-edge-range-qc.mjs",
  "scripts/deployed-edge-range-qc.test.mjs",
  "scripts/copc-edge-range-cache.mjs",
  "scripts/copc-edge-range-cache.test.mjs",
];

describe("Gaia3D competition scope contract", () => {
  it.each(forbiddenInfrastructurePaths)(
    "keeps external infrastructure artifact absent: %s",
    (relativePath) => {
      expect(existsSync(path.join(repositoryRoot, relativePath))).toBe(false);
    },
  );

  it("does not expose external deployment or edge-cache commands", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
    );

    expect(packageJson.scripts).not.toHaveProperty("qc:deployed-edge");
    expect(packageJson.scripts).not.toHaveProperty("benchmark:edge-range-cache");
    expect(JSON.stringify(packageJson.scripts)).not.toMatch(
      /cloudfront|\bcdn\b|deployed[-:]?edge|edge[-:]?(?:cache|server|deploy)/i,
    );
  });

  it("rejects renamed external-infrastructure scripts and performance claims", () => {
    const scriptNames = readdirSync(path.join(repositoryRoot, "scripts"));
    const executableScriptNames = scriptNames.filter(
      (name) => name !== "competition-scope.test.mjs",
    );
    const executableScriptText = executableScriptNames
      .filter((name) => name.endsWith(".mjs"))
      .map((name) => readFileSync(path.join(repositoryRoot, "scripts", name), "utf8"))
      .join("\n");
    const performance = readFileSync(
      path.join(repositoryRoot, "docs", "PERFORMANCE.md"),
      "utf8",
    );

    expect(executableScriptNames.join("\n")).not.toMatch(
      /cloudfront|\bcdn\b|deployed[-_]?edge|edge[-_]?(?:cache|server|deploy)/i,
    );
    expect(executableScriptText).not.toMatch(
      /AWS::|cloudfront|__copc_edge|createCopcEdgeRangeCache|benchmark:edge-range-cache/i,
    );
    expect(performance).not.toMatch(
      /cloudfront|origin\/CDN\/edge|edge range cache|edge server|benchmark:edge-range-cache/i,
    );
  });

  it("pins the official task and explicit scope boundary in project docs", () => {
    const readme = readFileSync(path.join(repositoryRoot, "README.md"), "utf8");
    const competition = readFileSync(
      path.join(repositoryRoot, "docs", "COMPETITION.md"),
      "utf8",
    );

    expect(readme).toContain("Competition scope boundary");
    expect(readme).toContain("external delivery infrastructure are explicitly out of scope");
    expect(competition).toContain(
      "https://www.kossa.kr/materials/2026/ossp/tasks-gaia3d.html",
    );
    expect(competition).toContain("## 공모전 범위 경계");
    expect(competition).toContain("범위 안:");
    expect(competition).toContain("범위 밖:");
  });
});
