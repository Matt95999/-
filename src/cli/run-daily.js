import { runDailyPipeline, resolveRootDir } from "../core/pipeline.js";

const rootDir = resolveRootDir(import.meta.url);
const boostKeywords = readBoostKeywords(process.argv.slice(2));

runDailyPipeline({ rootDir, mode: "daily_run", boostKeywords })
  .then((result) => {
    console.log(JSON.stringify({ ok: true, reportUrl: result.publishResult.reportUrl }, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });

function readBoostKeywords(args) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--boost-keywords") {
      return parseBoostValue(args[index + 1] || "");
    }
    if (arg.startsWith("--boost-keywords=")) {
      return parseBoostValue(arg.slice("--boost-keywords=".length));
    }
  }
  return [];
}

function parseBoostValue(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
