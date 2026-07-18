import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const qcPath = path.join(scriptDir, "qc.mjs");

test("lists deterministic product checks without live S3 evidence", () => {
  const result = runQc(["--product-only", "--list"]);
  const plan = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(plan.mode, "product-only");
  assert.deepEqual(plan.groups.map((group) => group.id), ["product"]);
  assert.ok(plan.groups[0].steps.includes("Package consumer smoke") === false);
  assert.ok(plan.groups[0].steps.includes("Renderer benchmark") === false);
});

test("lists live range proof before live performance and browser evidence", () => {
  const result = runQc(["--live-only", "--list"]);
  const plan = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(plan.mode, "live-only");
  assert.deepEqual(plan.groups.map((group) => group.id), ["live"]);
  assert.equal(plan.groups[0].steps[0], "Live COPC HTTP Range evidence");
  assert.equal(
    plan.groups[0].steps[1],
    "Cold detail camera-stream smoothness QC",
  );
  assert.ok(plan.groups[0].steps.includes("Renderer benchmark"));
  assert.ok(plan.groups[0].steps.includes("Package consumer smoke"));
  assert.ok(plan.groups[0].steps.includes("Contest camera-stream smoothness QC"));
});

test("contest-device omission removes only the duplicate warm live check", () => {
  const result = runQc(["--live-only", "--omit-warm-zoom-detail", "--list"]);
  const plan = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.ok(
    plan.groups[0].steps.includes("Warm zoom camera-stream smoothness QC") ===
      false,
  );
  assert.ok(plan.groups[0].steps.includes("Cold detail camera-stream smoothness QC"));
});

test("lists hosted release functional checks without smoothness gates", () => {
  const result = runQc(["--release-functional", "--list"]);
  const plan = JSON.parse(result.stdout);

  assert.equal(result.status, 0);
  assert.equal(plan.mode, "release-functional");
  assert.deepEqual(plan.groups.map((group) => group.id), [
    "product",
    "release-functional",
  ]);
  assert.deepEqual(plan.groups[1].steps, [
    "Live COPC HTTP Range evidence",
    "Renderer benchmark",
    "Package consumer smoke",
    "Browser local-file smoke",
  ]);
  assert.equal(
    plan.groups[1].steps.includes("Browser example smoke"),
    false,
  );
  assert.ok(
    plan.groups[1].steps.some((step) =>
      step.includes("camera-stream smoothness QC"),
    ) === false,
  );
});

test("rejects contradictory QC modes", () => {
  const result = runQc(["--product-only", "--live-only", "--list"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cannot be used together/);
});

test("rejects release functional combined with another QC mode", () => {
  const result = runQc(["--release-functional", "--live-only", "--list"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--live-only and --release-functional cannot be used together/);
});

test("records release functional status classification", () => {
  const qcScript = readFileSync(qcPath, "utf8");

  assert.match(qcScript, /mode: getMode\(\)/);
  assert.match(qcScript, /return "release-functional"/);
  assert.match(qcScript, /"release-functional-gate-passed"/);
});

test("keeps the main CI deterministic and moves live package proof to the browser workflow", () => {
  const ciWorkflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "ci.yml"),
    "utf8",
  );
  const liveWorkflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "example-smoke.yml"),
    "utf8",
  );

  assert.match(ciWorkflow, /run: npm run qc:product/);
  assert.doesNotMatch(ciWorkflow, /smoke:package|install-browser/);
  assert.match(liveWorkflow, /run: npm run live:copc-range/);
  assert.match(liveWorkflow, /run: npm run smoke:package/);
});

test("preserves classification evidence when release or publish QC cannot complete", () => {
  for (const workflowName of ["release-candidate.yml", "npm-publish.yml"]) {
    const workflow = readFileSync(
      path.join(repoRoot, ".github", "workflows", workflowName),
      "utf8",
    );

    assert.match(
      workflow,
      /name: Upload (?:reproduced )?QC classification diagnostics\s+if: always\(\)/,
    );
    assert.match(workflow, /output\/qc\/qc-status\.json/);
    assert.match(workflow, /output\/live-copc-range\/live-copc-range\.json/);
  }
});

test("preserves release functional browser evidence when QC fails", () => {
  const workflow = readFileSync(
    path.join(repoRoot, ".github", "workflows", "release-candidate.yml"),
    "utf8",
  );
  const diagnosticsStep = workflow.slice(
    workflow.indexOf("name: Upload QC classification diagnostics"),
    workflow.indexOf("name: Upload verified package and evidence"),
  );

  assert.match(diagnosticsStep, /if: always\(\)/);
  assert.match(
    diagnosticsStep,
    /output\/smoothness-benchmark\/\*\.json/,
  );
  assert.match(diagnosticsStep, /output\/renderer-benchmark\/\*\.json/);
  assert.match(diagnosticsStep, /output\/package-smoke\//);
  assert.match(diagnosticsStep, /output\/example-smoke\//);
  assert.match(diagnosticsStep, /output\/playwright\//);
});

test("release and publish reproduction workflows run functional release QC", () => {
  for (const workflowName of ["release-candidate.yml", "npm-publish.yml"]) {
    const workflow = readFileSync(
      path.join(repoRoot, ".github", "workflows", workflowName),
      "utf8",
    );

    assert.match(workflow, /run: npm run qc:release/);
    assert.doesNotMatch(workflow, /run: npm run qc$/m);
  }
});

function runQc(args) {
  return spawnSync(process.execPath, [qcPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
  });
}
