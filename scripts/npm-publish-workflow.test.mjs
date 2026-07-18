import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, test } from "vitest";

const workflowPath = fileURLToPath(
  new URL("../.github/workflows/npm-publish.yml", import.meta.url),
);
const workflow = readFileSync(workflowPath, "utf8");

describe("npm publish workflow", () => {
  test("can only be dispatched manually with an explicit confirmation", () => {
    assert.match(workflow, /^on:\n  workflow_dispatch:/m);
    assert.doesNotMatch(workflow, /^  (?:push|pull_request|release|schedule):/m);
    assert.match(workflow, /confirm_publish:[\s\S]*type: boolean[\s\S]*default: false/);
    assert.match(workflow, /release_candidate_run_id:[\s\S]*required: true[\s\S]*type: string/);
    assert.match(workflow, /if: \$\{\{ inputs\.confirm_publish \}\}/);
  });

  test("requires protected OIDC publication from a matching version tag", () => {
    assert.match(workflow, /^  id-token: write$/m);
    assert.match(workflow, /^    environment: npm$/m);
    assert.match(workflow, /RELEASE_REF_TYPE: \$\{\{ github\.ref_type \}\}/);
    assert.match(workflow, /expected="v\$\(node -p/);
    assert.match(workflow, /does not match package version/);
  });

  test("publishes only the checksum-verified approved release candidate", () => {
    assert.match(workflow, /^  actions: read$/m);
    assert.match(workflow, /RELEASE_CANDIDATE_RUN_ID[^\n]+\^\[0-9\]\+\$/);
    assert.match(workflow, /gh api "repos\/\$GITHUB_REPOSITORY\/actions\/runs\/\$RELEASE_CANDIDATE_RUN_ID"/);
    assert.match(workflow, /run_sha[^\n]+head_sha/);
    assert.match(workflow, /run_name[^\n]+\.name/);
    assert.match(workflow, /gh run download "\$RELEASE_CANDIDATE_RUN_ID"/);
    assert.match(workflow, /find approved-release-candidate[^\n]+-name '\*\.tgz'/);
    assert.match(workflow, /sha256sum --check/);
    assert.match(workflow, /approved_sha[^\n]+reproduced_sha/);
    assert.match(workflow, /echo "tarball=\$tarball" >> "\$GITHUB_OUTPUT"/);
    assert.match(
      workflow,
      /npm publish "\$\{\{ steps\.candidate\.outputs\.tarball \}\}" --access public --provenance --ignore-scripts/,
    );
  });

  test("reproduces the approved candidate with release functional QC", () => {
    assert.match(workflow, /run: npm run qc:release/);
    assert.doesNotMatch(workflow, /run: npm run qc$/m);
  });
});
