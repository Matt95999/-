import { runDailyPipeline, resolveRootDir } from "../core/pipeline.js";

const rootDir = resolveRootDir(import.meta.url);

runDailyPipeline({ rootDir, mode: "retry_failed_run" })
  .then((result) => {
    console.log(JSON.stringify({ ok: true, reportUrl: result.publishResult.reportUrl }, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
