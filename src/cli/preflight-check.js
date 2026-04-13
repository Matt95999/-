import { resolveRootDir } from "../core/pipeline.js";
import { runPreflightChecks } from "../core/preflight.js";

const rootDir = resolveRootDir(import.meta.url);
const mode = readModeFromArgs(process.argv.slice(2)) || "daily_run";
const result = await runPreflightChecks({ rootDir, mode });

console.log(JSON.stringify(result, null, 2));

if (!result.ok) {
  process.exitCode = 1;
}

function readModeFromArgs(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--mode") {
      return args[index + 1] || "";
    }
    if (arg.startsWith("--mode=")) {
      return arg.slice("--mode=".length);
    }
  }

  return "";
}
