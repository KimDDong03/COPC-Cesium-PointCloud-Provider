import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const isWindows = process.platform === "win32";
const npmCommand = "npm";

const steps = [
  ["Unit tests", npmCommand, ["test"]],
  ["Library and example build", npmCommand, ["run", "build"]],
  ["Renderer benchmark", npmCommand, ["run", "benchmark:renderers"]],
  [
    "Contest camera-stream smoothness QC",
    npmCommand,
    ["run", "benchmark:smoothness:contest"],
  ],
  [
    "Cold detail camera-stream smoothness QC",
    npmCommand,
    ["run", "benchmark:smoothness:cold-detail"],
  ],
  [
    "Warm zoom camera-stream smoothness QC",
    npmCommand,
    ["run", "benchmark:smoothness:warm-zoom-detail"],
  ],
  ["Package consumer smoke", npmCommand, ["run", "smoke:package"]],
  ["Browser example smoke", npmCommand, ["run", "smoke:example"]],
  ["Browser local-file smoke", npmCommand, ["run", "smoke:example:file"]],
  ["Whitespace check", "git", ["diff", "--check"]],
];

for (const [label, command, args] of steps) {
  console.log(`\n== ${label} ==`);
  run(command, args);
}

console.log("\nQC passed.");

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
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
